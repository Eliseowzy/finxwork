# The FinxWork disk image (dmgbuild settings; scripts/build-app.mjs passes
# the app, its icon and the background with -D). Finder opens it as a
# window with FinxWork on the left, an arrow, and Applications on the right:
# drag one onto the other to install. dmgbuild writes the window's
# .DS_Store itself, so no Finder scripting is needed.
#
# background.png and background@2x.png are drawn by
# scripts/make-dmg-background.swift; dmgbuild joins them into one HiDPI TIFF.

app = defines["app"]

# A read-only, zlib-compressed UDIF image, as Apple asks for in
# "Packaging Mac software for distribution".
format = "UDZO"
filesystem = "HFS+"

files = [app]
symlinks = {"Applications": "/Applications"}
icon = defines["icon"]
background = defines["background"]

window_rect = ((200, 200), (640, 400))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
icon_size = 128
text_size = 13
icon_locations = {"FinxWork.app": (176, 190), "Applications": (464, 190)}
