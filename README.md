# XBS Parts Checker

A web page for keeping track of printed **XBS Climber** pieces: count what you have, see how many complete sets that makes, and download exactly what's missing as numbered print plates.

**Open it:** https://jonarella09.github.io/xbs-parts-checker/

## What it does

- **Check pieces:** a photo of 291 printed pieces, each one marked and identified. Click any piece to compare it with a 3D picture of the part at the same scale.
- **Inventory:** every one of the 24 parts with how many you have and how many complete sets that covers. One set is 60 pieces.
- **Set builder:** go through a mixed pile one part at a time. It shows what each part looks like and how many one set needs. You count what you have, and it adds what's missing to your print list.
- **Print:** fill the list for any number of complete sets, then split it into print plates for your bed: fewest plates, by set, same number of pieces, one part per plate, by size, or same total size. Combine small plates. Download one STL per piece, one STL per part, or a ready-arranged .3mf per plate, with every plate and piece numbered.

## Good to know

- **Adding pieces from a photo is in beta and doesn't work reliably yet.** Counting by hand is reliable: use the Set builder, or type your counts in Inventory.
- The page opens with my current inventory: the 291 pieces in the main photo (3 complete sets), my print list and my plate plan, plus a second photo that's still being checked.
- Anything you change is saved in your own browser only. Nobody else sees it, it doesn't change the starting inventory, and it doesn't sync between devices.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app |
| `models.txt` | The 24 XBS Climber STL files, zipped and base64-encoded so GitHub Pages can serve them |
| `photo2.jpg` | The main photo of printed pieces |
| `added-photo-1.jpg` | A second photo, added with the beta photo tool |
| `thumbs/` | Rendered pictures of each part |

## Credits

The 3D models are **[XBS Climber](https://www.printables.com/model/1676140-xbs-climber/files)** by **[Experiential](https://www.printables.com/@Experiential_1229651)** ([@Experiential_1229651](https://www.printables.com/@Experiential_1229651)) on Printables. All credit for the design goes to them; check the model page for its license.

This checker is an unofficial helper and isn't affiliated with the designer.
