# kitty custom tab bar: per-tab gradient + soul accent colors
# Managed by reaper (global-chat/souls system). Loaded via tab_bar_style custom.

def _rgb_int(rgb):
    r, g, b = rgb
    return (r << 16) | (g << 8) | b

def _hex(h):
    h = h.lstrip("#")
    return (int(h[0:2],16), int(h[2:4],16), int(h[4:6],16))

def _lerp(a, b, t):
    return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))

SOUL_ACCENTS = {
    "reaper": (255, 42, 109),
    "crypt":  (0, 240, 255),
    "shovel": (252, 186, 10),
    "tomb":   (150, 120, 200),
    "moss":   (120, 200, 130),
}

def draw_tab(draw_data, screen, tab, before, max_tab_length, index, is_last, extra_data):
    # colors as (r,g,b)
    default_bg = _hex(format(draw_data.default_bg & 0xFFFFFF, "06x"))
    if tab.is_active:
        accent = SOUL_ACCENTS.get((tab.title or "").lower().split()[0] if tab.title else "", None)
        if accent is None:
            accent = _hex(format(draw_data.active_bg & 0xFFFFFF, "06x"))
        fg = _hex(format(draw_data.active_fg & 0xFFFFFF, "06x"))
    else:
        accent = _hex(format(draw_data.inactive_bg & 0xFFFFFF, "06x"))
        fg = _hex(format(draw_data.inactive_fg & 0xFFFFFF, "06x"))

    # fill the tab cell with a horizontal gradient accent -> default_bg
    start = screen.cursor.x
    width = max(1, max_tab_length)
    for i in range(width):
        t = i / max(1, width - 1)
        screen.cursor.bg = _rgb_int(_lerp(accent, default_bg, t))
        screen.draw(" ")

    # draw the title over the gradient
    screen.cursor.x = start
    screen.cursor.bg = _rgb_int(accent)
    screen.cursor.fg = _rgb_int(fg)
    screen.cursor.bold = tab.is_active
    title = (tab.title or "")[: max(0, max_tab_length - 1)]
    screen.draw(title + " " if title else " ")
    end = screen.cursor.x
    screen.cursor.bg = 0
    screen.cursor.fg = 0
    return end
