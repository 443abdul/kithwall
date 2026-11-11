facefinder.bin: the face-detection cascade used by "Blur faces" (apps/web/src/lib/photo/pico.ts, faces.ts).

What it is   A trained cascade of decision trees for the "pico" object detector: N. Markus, M. Frljak,
             I. S. Pandzic, J. Ahlberg, R. Forchheimer, "Object Detection with Pixel Intensity Comparisons
             Organized in Decision Trees", http://arxiv.org/abs/1305.4537. Data only, no code.
Source       https://github.com/nenadmarkus/pico  file rnt/cascades/facefinder
             (commit 7d550c78b2c31a4e1dfc5bcdfe9da013297b5cc8; the repository is under the MIT License since
             commit 346881039e5d1f5abe64733a49886bdfd5ab2d51, 2016-06-30; the file itself has not changed since)
Licence      MIT, Copyright (c) 2013 Nenad Markus. Full text in LICENSE.txt next to this file.
Size         239,632 bytes
SHA-256      d8014993e7298c7b1865d1f8b855d6dbf4ec5c808bf879e2091ab6837abf90cd
             (the app checks this before using the file; a unit test checks the file in the repository)

The file is served from the app's own origin and fetched only when someone opens "Blur faces" on a device
whose browser has no face detector of its own. The photo never leaves the device.
