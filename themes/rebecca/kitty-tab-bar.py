# kitty custom tab bar — rebecca theme (purple)
def _rgb(r,g,b): return (r<<16)|(g<<8)|b
def _hex(h): h=h.lstrip("#"); return (int(h[0:2],16),int(h[2:4],16),int(h[4:6],16))
def _lerp(a,b,t): return tuple(int(a[i]+(b[i]-a[i])*t) for i in range(3))
ACCENTS={"reaper":(102,51,153),"crypt":(0,240,255),"shovel":(180,142,255),"tomb":(150,120,200),"moss":(120,200,130)}
def draw_tab(draw_data, screen, tab, before, max_tab_length, index, is_last, extra_data):
    default_bg=_hex(format(draw_data.default_bg&0xFFFFFF,"06x"))
    if tab.is_active:
        name=(tab.title or "").lower().split()[0] if tab.title else ""
        accent=ACCENTS.get(name) or _hex(format(draw_data.active_bg&0xFFFFFF,"06x"))
        fg=_hex(format(draw_data.active_fg&0xFFFFFF,"06x"))
    else:
        accent=_hex(format(draw_data.inactive_bg&0xFFFFFF,"06x"))
        fg=_hex(format(draw_data.inactive_fg&0xFFFFFF,"06x"))
    start=screen.cursor.x
    width=max(1,max_tab_length)
    for i in range(width):
        t=i/max(1,width-1)
        screen.cursor.bg=_rgb(*_lerp(accent,default_bg,t))
        screen.draw(" ")
    screen.cursor.x=start
    screen.cursor.bg=_rgb(*accent)
    screen.cursor.fg=_rgb(*fg)
    screen.cursor.bold=tab.is_active
    title=(tab.title or "")[:max(0,max_tab_length-1)]
    screen.draw(title+" " if title else " ")
    end=screen.cursor.x
    screen.cursor.bg=0; screen.cursor.fg=0
    return end
