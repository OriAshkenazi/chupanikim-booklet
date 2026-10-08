# Booklet editor

A small static editor for a trip booklet: a sticker cover plus one "field notes" postcard per chapter,
exported at 18 × 13 cm, 300 dpi (JPEG per page, or the whole booklet as a PDF).

The code is public; the photos, stamps, stickers, paper and font are **not** in this repo. They live in a
private `booklet-pack.zip` that you open in the editor on your own device. It is stored only in that
browser (IndexedDB) and never uploaded.

- Cover: drag stickers; pinch (touch) or wheel / Shift+wheel (mouse) to resize / rotate the selected one;
  auto-arrange and shuffle; edit the title and dates.
- Chapters: pan / zoom the photo, move / resize the stamp, edit place, keywords and date.
- Settings: binding margin (mm; right / left / alternating), smooth or torn edge, which places to include,
  save / load your edits as JSON.
