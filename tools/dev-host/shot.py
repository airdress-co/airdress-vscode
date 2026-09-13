#!/usr/bin/env python3
"""Screenshot via xdg-desktop-portal (GNOME Wayland). Usage: shot.py OUT.png"""
import shutil, sys, time, urllib.parse
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib
out = sys.argv[1]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
sender = bus.get_unique_name()[1:].replace(".", "_")
token = f"shot{int(time.time())}"
handle = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
loop = GLib.MainLoop(); result = {}
def on_response(conn, sender_name, path, iface, signal, params):
    code, res = params.unpack(); result["code"], result["res"] = code, res; loop.quit()
bus.signal_subscribe("org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response", handle, None, Gio.DBusSignalFlags.NONE, on_response)
bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Screenshot", "Screenshot",
              GLib.Variant("(sa{sv})", ("", {"handle_token": GLib.Variant("s", token), "interactive": GLib.Variant("b", False)})), None, Gio.DBusCallFlags.NONE, 30000, None)
GLib.timeout_add_seconds(25, loop.quit); loop.run()
if result.get("code") != 0: sys.exit(f"portal refused: {result}")
uri = result["res"]["uri"]; shutil.copy(urllib.parse.unquote(uri[len("file://"):]), out); print(out)
