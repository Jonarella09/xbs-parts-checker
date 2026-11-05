# The Indexer

Count and index parts: screws, robot parts, field elements, 3D-printed kits. Everything runs in your browser. There's no account, no server and no AI service.

**Open it:** https://jonarella09.github.io/xbs-parts-checker/

Version 2.1 "Polaris" (phase 2 of the roadmap below).

## What it does

- **Projects.** Each project has its own parts, counts, kits and photos. Create as many as you like. **XBS Climber parts** comes built in.
- **Parts.** Add parts by hand (name, code, group, size, part number, pieces per package, weight), or from 3D models (.stl). A model gives the part a picture, exact sizes and print files.
- **Inventory.** See every part with its count, change counts by hand, filter what you're short of, and reset everything to zero when the pieces get used up. Earlier photos move to History.
- **Kits.** A kit is the list of parts, and how many of each, that build one of something. With a kit defined you see how many complete kits you have, what's missing for the next ones, and a shopping list. *Count part by part* walks you through a mixed pile one part at a time. Projects without a kit just count.
- **Count from a photo.** Three modes:
  - *Identify parts* matches every piece to a part in the project. Pieces it doesn't know are grouped by look, so you can name a whole group at once. Every correction teaches it.
  - *Count one kind*: tap one screw and it counts every piece like it, including clumps it estimates by size.
  - *Read package labels* reads every label on a table of packages (part number, name, pieces per pack), counts identical packages together, and adds new parts for numbers the project doesn't know yet.
- **Counting mat.** Print it at 100%. The four corner markers give exact sizes in millimetres (so an 8 mm and a 10 mm screw are told apart) and straighten photos taken at an angle.
- **Print.** Fill the print list for any number of kits, split it into plates (fewest, by kit, same count, one part per plate, by size, same total size), combine small plates, and download one STL per piece, one STL per part, or an arranged .3mf per plate. Every file has a clear, numbered name.
- **History.** Every photo (being checked, counted, archived) and every change to the counts.

## .star files

Projects are saved in the browser you use. **Save .star** writes the whole project (parts, models, photos, counts and history) to one file, so you can back it up or open it on another computer. In Chrome and Edge it keeps saving to the same file.

Install the app (Chrome or Edge: the install button in the address bar, or *Install The Indexer* on the home page) and it works offline. `.star` files then open in it when you double-click them, and they show a star icon.

## How the photo counting works

There's no cloud AI. It's classic computer vision running on your device:

1. **Mat:** finds the ArUco markers, corrects the perspective and sets the scale in mm.
2. **Background model:** learns the colour of the table or mat across the photo, including uneven light. A pixel counts as part of a piece when its colour differs from the table. Shadows are the same colour, only darker, so they're ignored (brightness/chromaticity distortion model).
3. **Pieces:** cleans up the result, separates the pieces, and fills holes while remembering them (washers, nuts and gears have holes).
4. **Touching pieces:** splits them with a distance-transform watershed. Clumps it can't split are estimated by area.
5. **Measuring:** each piece gets its length, width, area, solidity, holes, width profile along its length (a screw head shows up here), outline harmonics (gear teeth, hex nuts) and colour.
6. **Matching:** compares those measurements with each part's references. References come from pieces you confirmed, from the 3D model seen from above lying on each side, or from the size you typed. Without a mat, the scale is worked out from pieces that match parts of known size.

Package labels are read with PaddleOCR (PP-OCRv4) running in your browser through ONNX Runtime Web. It's a small open-source AI text reader; the first time it downloads about 30 MB, and after that it works offline. It finds each white label, reads it closely, reads the part number several times and votes letter by letter, and checks labels that look alike against each other, so one blurry digit doesn't create a new part. On our test photo (42 goBILDA packages on a wooden bench) it gets 40 of 42 packages right in a little over a minute.

**For best results:** use a plain background in a colour the pieces don't share (metal on blue or green paper is ideal), spread the pieces so they don't touch, use even light from above, and put the counting mat in the photo.

## Roadmap

- **Phase 1 (done):** XBS Parts Checker. Counted the XBS Climber pieces from a photo, built print plates.
- **Phase 2 (this version, 2.1 "Polaris"):** projects, .star files, any part with or without a model, kits, a general photo counter with learning, the counting mat and package labels.
- **Phase 3:** read and write 3MF projects. Import one file with a whole arranged plate, have the page arrange models by size and options, and more export choices.
- **Pre-phase 4:** research into other ways to count (weighing scales, pieces per gram, dispensers, trays with known slots, barcode bins, combinations) and full documentation of how the page works.
- **Phase 4:** counting by weight. Weigh one piece, then weigh the pile.
- **Later, to test:** optional in-browser AI models for cluttered backgrounds and look-alike parts. They'll only be added if they beat the measured approach on real photos.

## Credits

- **XBS Climber 3D model:** [XBS Climber](https://www.printables.com/model/1676140-xbs-climber/files) by [Experiential](https://www.printables.com/@Experiential_1229651) (@Experiential_1229651) on Printables. All credit for the design goes to them; check the model page for its license. This tool is an unofficial helper.
- **Libraries:** [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv4 models (Apache-2.0) via [@gutenye/ocr-models](https://www.npmjs.com/package/@gutenye/ocr-models), [ONNX Runtime Web](https://onnxruntime.ai) (MIT), [js-aruco2](https://github.com/damianofalcioni/js-aruco2) (MIT), [three.js](https://threejs.org) (MIT), [JSZip](https://stuk.github.io/jszip/) (MIT).
