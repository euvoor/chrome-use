"""Read the hosted Xvfb desktop through Xlib, without browser instrumentation."""
import ctypes as c
import os
import pathlib
import struct
import sys
import zlib

assert os.environ.get("GITHUB_ACTIONS") == "true", "Hosted CI only"
assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "Disposable hosted runner only"
assert os.getuid() != 0
assert os.environ.get("DISPLAY"), "A virtual display is required"
lib = c.CDLL("libX11.so.6")
lib.XOpenDisplay.argtypes = [c.c_char_p]
lib.XOpenDisplay.restype = c.c_void_p
lib.XDefaultRootWindow.argtypes = [c.c_void_p]
lib.XDefaultRootWindow.restype = c.c_ulong
lib.XGetImage.argtypes = [c.c_void_p, c.c_ulong, c.c_int, c.c_int,
                          c.c_uint, c.c_uint, c.c_ulong, c.c_int]
lib.XGetImage.restype = c.c_void_p
lib.XGetPixel.argtypes = [c.c_void_p, c.c_int, c.c_int]
lib.XGetPixel.restype = c.c_ulong
lib.XDestroyImage.argtypes = [c.c_void_p]
lib.XCloseDisplay.argtypes = [c.c_void_p]


class ImageHeader(c.Structure):
    _fields_ = [(key, c.c_int) for key in ("width", "height", "xoffset", "format")]
    _fields_ += [("data", c.c_void_p)]
    _fields_ += [(key, c.c_int) for key in ("byte_order", "bitmap_unit", "bitmap_bit_order",
                                          "bitmap_pad", "depth", "bytes_per_line", "bits_per_pixel")]
    _fields_ += [(key, c.c_ulong) for key in ("red_mask", "green_mask", "blue_mask")]


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


display = lib.XOpenDisplay(os.environ["DISPLAY"].encode())
assert display, "Cannot open virtual display"
image = None
try:
    width, height = 1440, 1000
    image = lib.XGetImage(display, lib.XDefaultRootWindow(display), 0, 0,
                          width, height, c.c_ulong(-1).value, 2)
    assert image, "Cannot read virtual desktop"
    header = c.cast(image, c.POINTER(ImageHeader)).contents
    assert (header.width, header.height) == (width, height)
    assert (header.red_mask, header.green_mask, header.blue_mask) == (0xff0000, 0xff00, 0xff), \
        "Unexpected Xvfb pixel layout"
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # PNG filter: none.
        for x in range(width):
            pixel = lib.XGetPixel(image, x, y)
            rows.extend(((pixel >> 16) & 255, (pixel >> 8) & 255, pixel & 255))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    pathlib.Path(sys.argv[1]).write_bytes(png)
finally:
    if image:
        lib.XDestroyImage(image)
    lib.XCloseDisplay(display)
