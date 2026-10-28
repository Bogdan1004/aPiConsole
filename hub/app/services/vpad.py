"""A virtual gamepad on the Pi (Linux uinput), driven by a paired phone.

Games on the TV (RetroArch, SuperTuxKart…) read real controllers only, not the console's web page, so the phone's
buttons become a controller the whole system sees. It presents itself like an Xbox 360 pad (same buttons, hat
D-pad and IDs), which RetroArch, SDL games and Chromium already understand; the console's own menus then work with
it like with any controller.

Needs write access to /dev/uinput, given once by kiosk/setup-phone-pad.sh (sudo).
"""

import fcntl
import logging
import os
import struct
import threading

log = logging.getLogger("apistation.vpad")

UINPUT = "/dev/uinput"
UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_ABSBIT = 0x40045564, 0x40045565, 0x40045567
UI_DEV_CREATE, UI_DEV_DESTROY = 0x5501, 0x5502
EV_SYN, EV_KEY, EV_ABS = 0x00, 0x01, 0x03
ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ, ABS_HAT0X, ABS_HAT0Y = 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x10, 0x11

# Phone button → evdev code, laid out like the xpad driver reports an Xbox 360 pad.
BUTTONS = {
    "a": 0x130,       # BTN_SOUTH
    "b": 0x131,       # BTN_EAST
    "x": 0x133,       # BTN_X (left face button on xpad)
    "y": 0x134,       # BTN_Y (top)
    "lb": 0x136,      # BTN_TL
    "rb": 0x137,      # BTN_TR
    "select": 0x13A,  # BTN_SELECT (Back)
    "start": 0x13B,   # BTN_START
}
EXTRA_KEYS = (0x13C, 0x13D, 0x13E)  # BTN_MODE, BTN_THUMBL, BTN_THUMBR: present on a real pad, never pressed
AXES = {ABS_X: (-32768, 32767), ABS_Y: (-32768, 32767), ABS_RX: (-32768, 32767), ABS_RY: (-32768, 32767),
        ABS_Z: (0, 255), ABS_RZ: (0, 255), ABS_HAT0X: (-1, 1), ABS_HAT0Y: (-1, 1)}
NAME = b"aPiStation Phone Pad"
EVENT = struct.Struct("llHHi")


class VirtualPad:
    def __init__(self):
        self.fd: int | None = None
        self.error: str | None = None
        self.held: set[str] = set()
        self._lock = threading.Lock()

    @property
    def possible(self) -> bool:
        return os.access(UINPUT, os.W_OK)

    def _open(self) -> bool:
        if self.fd is not None:
            return True
        try:
            fd = os.open(UINPUT, os.O_WRONLY | os.O_NONBLOCK)
        except OSError as exc:
            self.error = f"{UINPUT}: {exc.strerror}"
            return False
        try:
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_ABS)
            for code in (*BUTTONS.values(), *EXTRA_KEYS):
                fcntl.ioctl(fd, UI_SET_KEYBIT, code)
            absmax, absmin = [0] * 64, [0] * 64
            for code, (lo, hi) in AXES.items():
                fcntl.ioctl(fd, UI_SET_ABSBIT, code)
                absmin[code], absmax[code] = lo, hi
            # struct uinput_user_dev: name, input_id (bus, vendor, product, version), ff_effects_max, abs ranges
            setup = struct.pack("80sHHHHI64i64i64i64i", NAME, 0x03, 0x045E, 0x028E, 0x0110, 0,
                                *absmax, *absmin, *([0] * 64), *([0] * 64))
            os.write(fd, setup)
            fcntl.ioctl(fd, UI_DEV_CREATE)
        except OSError as exc:
            os.close(fd)
            self.error = f"uinput setup failed: {exc.strerror}"
            return False
        self.fd, self.error = fd, None
        log.info("Virtual gamepad created")
        return True

    def _emit(self, events: list[tuple[int, int, int]]) -> None:
        data = b"".join(EVENT.pack(0, 0, t, c, v) for t, c, v in events) + EVENT.pack(0, 0, EV_SYN, 0, 0)
        os.write(self.fd, data)

    def ensure(self) -> bool:
        """Create the pad ahead of time: programs need a moment to notice a new controller."""
        with self._lock:
            return self._open()

    def set(self, button: str, down: bool) -> bool:
        """Press or release one phone button; False when the pad can't be created."""
        with self._lock:
            if not self._open():
                return False
            (self.held.add if down else self.held.discard)(button)
            if button in BUTTONS:
                self._emit([(EV_KEY, BUTTONS[button], int(down))])
            else:  # the D-pad is a hat, like on an Xbox 360 pad
                h = self.held
                self._emit([(EV_ABS, ABS_HAT0X, -1 if "left" in h else 1 if "right" in h else 0),
                            (EV_ABS, ABS_HAT0Y, -1 if "up" in h else 1 if "down" in h else 0)])
            return True

    def release_all(self) -> None:
        with self._lock:
            if self.fd is None or not self.held:
                self.held.clear()
                return
            events = [(EV_KEY, BUTTONS[b], 0) for b in self.held if b in BUTTONS]
            self._emit(events + [(EV_ABS, ABS_HAT0X, 0), (EV_ABS, ABS_HAT0Y, 0)])
            self.held.clear()

    def close(self) -> None:
        with self._lock:
            if self.fd is not None:
                try:
                    fcntl.ioctl(self.fd, UI_DEV_DESTROY)
                finally:
                    os.close(self.fd)
                    self.fd = None
