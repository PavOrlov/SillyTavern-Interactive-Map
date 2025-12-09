# SillyTavern-Interactive Map Extension

## Description
**Version:** 1.0 Beta  
**Author:** Pavel Orlov  
**Adaptation:** SillyTavern 1.13.5+  
**Status:** preliminary version  
**License:** CC BY-NC-SA 4.0 http://creativecommons.org/licenses/by/4.0/

Created with love for the SillyTavern community (and for myself).

Special thanks to:
- Kevin MacLeod (incompetech.com). His music, graciously donated to all humanity for free, is used in this extension.
- The SillyTavern team for an amazing platform
- Volunteer testers

An extension for SillyTavern that adds support for interactive maps with clickable zones, sound accompaniment, image and video display.

For clarity, my artwork inspired by The SIMS 4 game is used as map images, and the beautiful Seraphina is featured as a character in the final location.

There is absolute creative freedom — from interactive maps of galaxies and starships to maps from your favorite games.

⚠️ **Important Copyright Notice**

This plugin complies with the CC Attribution — Noncommercial — Share Alike license agreement (abbreviated CC BY-NC-SA 4.0), with the original author being Pavel Evgenyevich Orlov.

📜 **Terms of Use:**

This license allows others to adapt, modify, and develop the work on a non-commercial basis, provided they credit the original author and license derivative works under the same license terms. 
Users can not only obtain and distribute the work under terms identical to this license ("by-nc-sa"), but also translate and create other derivative works based on this work. 
All new works based on this will have the same licenses, so all derivative works will also be non-commercial in nature.

Removal or falsification of author information, or commercial use, violates the CC BY-NC-SA 4.0 license agreement, 
for which the violator bears legal responsibility in accordance with the severity of the violation. 
This project has a complete commit history on GitHub to verify originality.

## Key Features

- 🗺️ Loading and displaying interactive SVG maps with background images
- 🖱️ Clickable zones with STScript command execution — single or multiple commands (character in location, introduction line, sound, image, video)
- 🔈 Sound accompaniment for maps (MP3, OGG, WAV, M4A, WebM)
- 🖼️ Image display in map window (PNG, JPG, JPEG, WebP, GIF)
- 🎬 Video playback in map window (MP4, WebM, OGG, M4V)
- 📂 Automatic map detection via `index.json`
- 🔄 Support for multiple maps with dynamic selection and the ability to nest them in a hierarchy
- 🎨 Visual effects when hovering over interactive zones
- 💾 Caching of loaded maps for improved performance

## File Structure

```
scripts/extensions/third-party/SillyTavern-Interactive Map/
├── index.js          # Main extension file
├── index.json        # Index of available maps (optional)
├── maps/             # Folder with JSON map files
│   └── example.json
├── images/           # Background images for maps
│   └── example.png
├── sounds/           # Sound files
│   └── ambient.mp3
├── movies/           # Video files
│   └── cutscene.mp4
└── README.md         # Documentation
```

## Map File Format

Each map is a JSON file with the following structure (example):

```json
{
	"version": "1.0 Beta",
	"mapSound": "Test.mp3",
	"metadata": {
		"name": "Chess-table",
		"author": "Pavel Orlov",
		"description": "Interactive map with chess table by the fountain",
		"created": "2025-11-01",
		"updated": "2025-11-01"
	},
	"backgroundImage": {
		"file": "images/background.png",
		"width": "1920",
		"height": "1080"
	},
	"mapSound": "sounds/ambient.mp3",
	"shapes": [
		{
			"id": "zone1",
			"type": "object",
			"path": "M 100, 100 L 200, 100 L 200, 200 L 100, 200 Z",
			"color": "#FF0000",
			"tooltip": "Click for action",
			"script": "/..."
		}
	]
}
```

### Map Fields

#### backgroundImage (required)
- `file` (string): Path to map image relative to extension folder
- `width` (number/string): Image width in pixels
- `height` (number/string): Image height in pixels

#### mapSound (optional)
- Path to audio file for automatic playback when map is loaded

#### shapes (required) — map objects highlighted by SVG zones

Array of interactive zones:
- `id` (string): Unique zone identifier
- `type` (string): Object type
- `path` (string): SVG path for defining zone area in inline notation
- `color` (string): Fill color on hover (HEX format: #RRGGBB or #RGB)
- `script` (string): STScript command or commands to execute when clicking on SVG zone
- `tooltip` (string, optional): Tooltip text

## index.json File

To enable automatic map detection, create an `index.json` file in the extension root:

```json
[
	"maps/city.json",
	"maps/dungeon.json",
	"maps/world.json"
]
```

If the file is not found, the extension will use the default map: `SillyTavern.json`.

## Slash Commands

### /showmap [map_name]
Opens the map window and loads the specified map.

**Examples:**
```
/showmap city
/showmap maps/dungeon.json
/showmap
```

- Without parameters, loads the last selected map
- Supports partial file name matching
- Automatically adds `.json` extension if not specified

### /showmap_sound [sound_name] [sound=alternate_file]
Plays sound from the `sounds/` folder.

**Examples:**
```
/showmap_sound ambient
/showmap_sound sounds/forest.mp3
/showmap_sound "Secluded corner"
```

**Parameters:**
- Main argument: file name (extension optional, defaults to `.mp3`)
- `sound=`: alternate file name for playback

Similar for video and image files.

### /stopsound
Stops current map sound playback.

**Example:**
```
/stopsound
```

### /showmap_image [file] [size=NN]
Displays image in map window from `images/` folder.

**Examples:**
```
/showmap_image portrait.png
/showmap_image scene size=80
/showmap_image images/artwork.jpg size=50
```

**Parameters:**
- Main argument: file name (extension optional, defaults to `.png`)
- `size=NN`: size in percentage (10-100)

**Supported formats:** PNG, JPG, JPEG, WebP, GIF

### /stopimage
Hides current image in map window.

**Example:**
```
/stopimage
```

### /showmap_video [file] [muted=0/1] [loop=0/1] [size=NN]
Plays video in map window from `movies/` folder.

**Examples:**
```
/showmap_video cutscene.mp4
/showmap_video intro muted=1 loop=1
/showmap_video battle size=60
/showmap_video movies/outro.webm muted=0 loop=0 size=80
```

**Parameters:**
- Main argument: file name (extension optional, defaults to `.mp4`)
- `muted=1`: mute audio (0 or 1)
- `loop=1`: loop playback (0 or 1)
- `size=NN`: size in percentage (10-100)
- By default, video plays automatically

**Supported formats:** MP4, WebM, OGG, M4V

### /stopvideo
Stops and hides current video in map window.

**Example:**
```
/stopvideo
```

## Usage in UI

### Button in extensions menu (at bottom)
After installation, a **"🌍 Last selected map"** button appears in the extensions menu that opens the last selected map.

### Buttons in extension settings panel (at top)
In the **Extensions Settings** section, available options include:
- Dropdown list for map selection
- **"Load map"** button
- **"Refresh"** button to update the list of available maps

## Extension Settings

Settings are specified in the `mapSettings` object in the `index.js` file:

```javascript
const mapSettings = {
	hoverOpacity: 0.3,           // Opacity of zones on hover (0-1)
	transitionDuration: 200,     // Animation duration in ms
	enableTooltips: true,        // Enable tooltips
	debugMode: false,            // Debug mode in console
	maxMapCache: 10,             // Maximum maps in cache
	fetchTimeout: 10000,         // Map load timeout (ms)
	indexTimeout: 3000,          // index.json load timeout (ms)
	defaultMap: 'SillyTavern.json' // Default map
};
```

## Creating SVG paths for Zones

When creating SVG zone boundary definitions, I used [Image Coordinate Picking Online](https://www.lddgo.net/en/image/coordinate-pick).

To convert data into inline format and copy it into JSON maps, I created a utility `SVG_points_→_M-L-Z.html` (located in the Tools directory).

SVG paths can be created in several ways:

### 1. Graphic editors
- **Inkscape** (free): draw shape → copy `d` attribute from XML
- **Adobe Illustrator**: export as SVG → copy path
- **Figma/Sketch**: export SVG → extract path

### 2. Online tools
- [Image Coordinate Picking Online](https://www.lddgo.net/en/image/coordinate-pick)
- [SVG Path Editor](https://yqnn.github.io/svg-path-editor/)
- [Method Draw](https://editor.method.ac/)

### 3. Path Examples

**Rectangle:**
```
M 10,10 L 100,10 L 100,100 L 10,100 Z
```

**Circle (approximate):**
```
M 50,10 A 40,40 0 1,1 50,90 A 40,40 0 1,1 50,10 Z
```

**Polygon:**
```
M 50,10 L 90,90 L 10,50 Z
```

## Security

The extension includes protection against path traversal attacks:
- Paths containing `..` are forbidden
- Absolute paths are forbidden
- All paths must be relative within the extension folder

## Requirements

- SillyTavern (latest version)
- jQuery (built into SillyTavern)
- Modern browser with ES6+ support

---

**Documentation version:** 1.0  
**Date:** December 2025

If you liked it and would like to treat the author to a cup of coffee: https://buymeacoffee.com/pav00rl0v6

![photo_2025-12-09_13-24-43](https://github.com/user-attachments/assets/962bb34e-5e2b-4902-b0a1-b831bad2ce2f)

