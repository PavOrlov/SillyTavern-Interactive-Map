/**

* SillyTavern-Interactive Map Extension - VERSION 1.0 Beta
* Main module for interactive maps extension

* Functionality:
* - Loading and displaying interactive maps
* - Executing STScript commands on map zone clicks
* - Automatic map detection in "maps" folder via index.json
* - Support for multiple maps with dynamic selection
* - Ability to nest maps with level transitions
* - Map data structure validation
*/

const EXTENSION_VERSION = '1.0 Beta';

import { loadMovingUIState } from '../../../power-user.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { registerSlashCommand, executeSlashCommands } from '../../../slash-commands.js';

// ===== CONFIGURATION =====
const extensionName = 'SillyTavern-Interactive Map';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const DEFAULT_MAP = 'SillyTavern.json'; // Moved to constant

const SELECTORS = {
  SVG_CONTAINER: '#svg-container',
  MAP_SELECTIONS: '#mapSelections',
  EXTENSIONS_MENU: '#extensionsMenu',
};

const mapSettings = {
  hoverOpacity: 0.3,
  transitionDuration: 200,
  enableTooltips: true,
  debugMode: false,
  maxMapCache: 10,
  fetchTimeout: 10000,
  indexTimeout: 3000,
  defaultMap: DEFAULT_MAP // Added to settings
};

const mapCache = new Map();

const extensionState = {
  currentLoadedMap: null,
  availableMaps: [],
  isMapLoaded: false,
  lastError: null,
  currentMapElement: null, // Actually used
  // svgContainer: null, ← DELETION: searched via getElementById each time
};

// ===== VALIDATION =====
/**
* Full map structure validation.
* @param {unknown} data
* @returns {{ valid: boolean, errors: string[] }}
*/
function validateMapData(data) {
    /** @type {string[]} */
    const errors = [];

    if (!data || typeof data !== 'object') {
        return { valid: false, errors: ['Map data must be an object'] };
    }

    /** @typedef {Object} MapBackground
     *  @property {string} file
     *  @property {number|string} width
     *  @property {number|string} height
     */

    /** @typedef {Object} MapShape
     *  @property {string} id
     *  @property {string} path
     *  @property {string} color
     *  @property {string} script
     *  @property {string} [tooltip]
     */

    /** @type {MapData} */
    const map = /** @type {MapData} */ (data);
    const bg = map.backgroundImage;

    if (!bg || typeof bg.file !== 'string') {
        errors.push('backgroundImage.file: required and must be a string');
    }

    const width = Number(bg?.width);
    const height = Number(bg?.height);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        errors.push('backgroundImage.width/height: must be positive numbers');
    }

    if (!Array.isArray(map.shapes) || map.shapes.length === 0) {
        errors.push('shapes: must be non-empty array');
    } else {
        map.shapes.forEach((shape, i) => {
            validateShape(shape, i, errors);
        });
    }

    return { valid: errors.length === 0, errors };
}

/**
* Validation of individual map shape.
* @param {unknown} shape
* @param {number} index
* @param {string[]} errors
*/
function validateShape(shape, index, errors) {
    if (!shape || typeof shape !== 'object') {
        errors.push(`Shape[${index}]: must be an object`);
        return;
    }

    const s = /** @type {MapShape} */ (shape);
    const prefix = `Shape[${index}]`;

    if (!s.id || !s.path || !s.color || !s.script) {
        errors.push(`${prefix}: missing required fields (id, path, color, script)`);
    }

    if (typeof s.script !== 'string') {
        errors.push(`${prefix}.script: must be a string`);
    }

    if (typeof s.path !== 'string') {
        errors.push(`${prefix}.path: must be a string`);
    }

    if (!isValidColor(s.color)) {
        errors.push(`${prefix}.color: invalid color "${s.color}"`);
    }
}

function isValidColor(color) {
  return /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color);
}

// ===== PATH TRAVERSAL PROTECTION =====
/**
* Protection against path traversal attacks
* @param {string} filePath - File path to check
* @throws {Error} If path contains dangerous sequences
* @returns {boolean} true if path is safe
*/
function validateAssetPath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Path must be a string');
  }
  
  // Prevent exiting folder boundaries
  if (filePath.includes('..') || 
      filePath.startsWith('/') || 
      filePath.startsWith('\\') ||
      filePath.includes('\\\\')) {
    throw new Error(`Invalid file path: ${filePath}`);
  }
  
  // Additional check for absolute paths
  if (/^[a-zA-Z]:/.test(filePath)) {
    throw new Error(`Absolute paths forbidden: ${filePath}`);
  }
  
  return true;
}

// ===== HELPER UTILITIES =====
/**
* Loads JSON with timeout and proper resource cleanup
*/
async function fetchJsonWithTimeout(url, {
    timeout = 10000,
    init = {},
    treatNotOkAsEmpty = false,
    timeoutMessage = 'Timeout loading resource',
} = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, { ...init, signal: controller.signal });

        if (!response.ok) {
            if (treatNotOkAsEmpty) return null;
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        let data;
        try {
            data = await response.json();
        } catch (parseError) {
            throw new Error(`JSON parse error: ${parseError.message}`);
        }

        return data;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(timeoutMessage);
        }
        throw error;
    } finally {
        // Guaranteed timeout cleanup
        clearTimeout(timeoutId);
    }
}

// ===== MAP LOADING =====
async function tryLoadMapsFromIndex() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), mapSettings.indexTimeout);
  
  try {
    const response = await fetch(`${extensionFolderPath}/index.json`, {
      cache: 'no-cache',
      signal: controller.signal
    });
    
    // Clear timeout only ONCE on success
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      return [];
    }
    
    let index;
    try {
      index = await response.json();
    } catch (parseError) {
      console.debug('[Map] Parsing error index.json:', parseError);
      return [];
    }
    
    const maps = Array.isArray(index) ? index : (index.maps || []);
    if (mapSettings.debugMode && maps.length > 0) {
      console.log('[Map] Maps loaded:', maps);
    }
    
    return maps;
    
  } catch (fetchError) {
    // Clear timeout only if not already cleared
    clearTimeout(timeoutId);
    
    if (fetchError.name === 'AbortError') {
      console.debug('[Map] Timeout loading index.json');
    } else {
      console.debug('[Map] Error loading index.json (это нормально):', fetchError.message);
    }
    
    return [];
  }
}

async function discoverAvailableMaps() {
  try {
    const indexedMaps = await tryLoadMapsFromIndex();
    extensionState.availableMaps = indexedMaps.length > 0 
      ? indexedMaps 
      : [mapSettings.defaultMap]; // Using constant
    return extensionState.availableMaps;
  } catch (error) {
    console.error('[Map] Error discovering maps:', error);
    extensionState.availableMaps = [mapSettings.defaultMap];
    return [mapSettings.defaultMap];
  }
}

/**
* Loads map data from file or cache
* @param {string} mapName - Map file name/path (relative to extension folder)
* @returns {Promise} Validated map data
* @throws {Error} On timeout, HTTP error or validation error
*/
async function loadMapData(mapName) {
    if (mapCache.has(mapName)) {
        if (mapSettings.debugMode) console.log('[Map] Loading from cache:', mapName);
        return mapCache.get(mapName);
    }

    try {
        validateAssetPath(mapName);
        const mapPath = `${extensionFolderPath}/${mapName}`;
        
        const data = await fetchJsonWithTimeout(mapPath, {
            timeout: mapSettings.fetchTimeout,
            timeoutMessage: `Timeout loading map: ${mapName}`,
            treatNotOkAsEmpty: false,
        });

        const validation = validateMapData(data);
        if (!validation.valid) {
            throw new Error(`Validation error: ${validation.errors.join('; ')}`);
        }

        // Cache management
        if (mapCache.size >= mapSettings.maxMapCache) {
            const firstKey = mapCache.keys().next().value;
            mapCache.delete(firstKey);
        }
        mapCache.set(mapName, data);

        if (mapSettings.debugMode) console.log('[Map] Map loaded:', mapName);
        return data;
    } catch (error) {
        extensionState.lastError = error;
        throw error;
    }
}

// ===== VISUALIZATION =====
function resolveAssetPath(filePath) {
  // Path safety check
  validateAssetPath(filePath);
  
  if (filePath.startsWith('scripts/')) {
    return filePath;
  }
  return `${extensionFolderPath}/${filePath}`;
}

// ===== 🔈 MAP AUDIO SUPPORT =====

let mapAudioElement = null;

/**
* Returns or creates hidden audio element for maps
* @returns {HTMLAudioElement} Audio element
*/
function getOrCreateMapAudioElement() {
  // Check if element still exists in DOM
  if (mapAudioElement && document.body.contains(mapAudioElement)) {
    return mapAudioElement;
  }
  
  const audio = document.createElement('audio');
  audio.id = 'mapSoundPlayer';
  audio.style.display = 'none';
  audio.preload = 'auto';
  // audio.loop = true; // enable if looping needed
  
  document.body.appendChild(audio);
  mapAudioElement = audio;
  
  return audio;
}

/**
* Stops current audio if playing
*/
function stopCurrentMapAudio() {
  if (!mapAudioElement || !document.body.contains(mapAudioElement)) {
    return;
  }
  
  try {
    mapAudioElement.pause();
    mapAudioElement.currentTime = 0;
  } catch (error) {
    console.error('[Map] Error stopping audio:', error);
  }
}

/**
* Plays audio file from extension sounds folder
* @param {string} soundFileName - file name or relative path within sounds
* @returns {Promise}
*/
async function playMapSound(soundFileName) {
    try {
        if (!soundFileName) return;

        let relativePath = soundFileName.trim();

        // Ensure path points to sounds folder
        if (!relativePath.toLowerCase().startsWith('sounds/')) {
            relativePath = `sounds/${relativePath}`;
        }

        // Add .mp3 by default if no extension
        const lower = relativePath.toLowerCase();
        const hasExt =
            lower.endsWith('.mp3') ||
            lower.endsWith('.ogg') ||
            lower.endsWith('.wav') ||
            lower.endsWith('.m4a') ||
            lower.endsWith('.webm');

        if (!hasExt) {
            relativePath += '.mp3';
        }

        // Security check for relative path within extension
        validateAssetPath(relativePath);

        const audioSrc = `${extensionFolderPath}/${relativePath}`;
        const audio = getOrCreateMapAudioElement();

        // Prepare new track
        stopCurrentMapAudio();
        audio.src = audioSrc;
        audio.currentTime = 0;

        audio.onended = () => {
            if (mapSettings.debugMode) {
                console.log('[Map] Audio finished:', audioSrc);
            }
        };

        audio.onerror = (e) => {
            const msg = `Map audio file error: ${audioSrc}`;
            console.error('[Map] Audio error:', msg, e);
            if (typeof toastr !== 'undefined') {
                toastr.error(msg);
            }
        };

        if (mapSettings.debugMode) {
            console.log('[Map] Playing audio:', audioSrc);
        }

        const playPromise = audio.play();
        if (playPromise && typeof playPromise.then === 'function') {
            playPromise.catch(err => {
                console.error('[Map] Error starting playback:', err);
                if (typeof toastr !== 'undefined') {
                    toastr.error('Could not start map sound playback');
                }
            });
        }
    } catch (error) {
        console.error('[Map] Ошибка в playMapSound:', error);
        if (typeof toastr !== 'undefined') {
            toastr.error(`Audio error: ${error.message}`);
        }
    }
}

// ===== 🖼 IMAGE IN MAP WINDOW =====
let mapImageElement = null;
let mapImageCloseButton = null;

/**
* Returns or creates img element inside map window
*/
function getOrCreateMapImageElement() {
    const container = document.querySelector('#map .dragContent') || document.getElementById('map');
    if (!container) return null;

    // Already exists in correct container
    if (mapImageElement && container.contains(mapImageElement)) {
        // Ensure button is also in container
        if (mapImageCloseButton && !container.contains(mapImageCloseButton)) {
            container.appendChild(mapImageCloseButton);
        }
        return mapImageElement;
    }

    const img = document.createElement('img');
    img.id = 'mapImageViewer';
    img.alt = '';
    img.style.position = 'absolute';
    img.style.top = '0';
    img.style.left = '0';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'contain';
    img.style.borderRadius = '8px';
    img.style.background = 'rgba(0,0,0,.1)';
    img.style.zIndex = '9'; // below video (video 10), above SVG
    img.style.display = 'none';
    container.appendChild(img);
    mapImageElement = img;

    // Close button (one for entire image)
    if (!mapImageCloseButton) {
        const btn = document.createElement('button');
        btn.id = 'mapImageClose';
        btn.textContent = 'Close';
        btn.style.position = 'absolute';
        btn.style.top = '48px';
        btn.style.right = '12px';
        btn.style.zIndex = '11';
        btn.style.padding = '6px 14px';
        btn.style.fontSize = '14px';
        btn.style.border = 'none';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.style.background = 'rgba(0, 0, 0, 0.7)';
        btn.style.color = '#fff';
        btn.style.boxShadow = '0 2px 4px rgba(0,0,0,0.4)';
        btn.addEventListener('click', () => {
            stopCurrentMapImage();
        });
        mapImageCloseButton = btn;
    }

    container.appendChild(mapImageCloseButton);
    mapImageCloseButton.style.display = 'none';

    return img;
}

/**
* Hides current image
*/
function stopCurrentMapImage() {
    try {
        // Hide image if it exists in DOM
        if (mapImageElement && document.body && document.body.contains(mapImageElement)) {
            mapImageElement.removeAttribute('src');
            mapImageElement.style.display = 'none';
        }

        // Hide Close button if it exists in DOM
        if (mapImageCloseButton && document.body && document.body.contains(mapImageCloseButton)) {
            mapImageCloseButton.style.display = 'none';
        }
    } catch (e) {
        console.error('[Map]  Error stopping image:', e);
    }
}

/**
* Shows image from extension images folder
* Supports: .png, .jpg, .jpeg, .webp, .gif
* @param {string} imageName
* @param {{sizePct?: number}} opts
*/
async function showMapImage(imageName, opts = {}) {
    try {
        if (!imageName) return;

        let relativePath = imageName.trim();
        if (!relativePath.toLowerCase().startsWith('images/')) {
            relativePath = `images/${relativePath}`;
        }

        const lower = relativePath.toLowerCase();
        const hasExt =
            lower.endsWith('.png') ||
            lower.endsWith('.jpg') ||
            lower.endsWith('.jpeg') ||
            lower.endsWith('.webp') ||
            lower.endsWith('.gif');

        if (!hasExt) {
            // default to .png
            relativePath += '.png';
        }

        // Path security check
        validateAssetPath(relativePath);

        const imgSrc = `${extensionFolderPath}/${relativePath}`;
        const img = getOrCreateMapImageElement();
        if (!img) {
            if (typeof toastr !== 'undefined') {
                toastr.warning('Map window not open');
            }
            return;
        }

        // Hide/clear previous image and button
        stopCurrentMapImage();

        img.style.display = 'block';
        img.src = imgSrc;

        // Resize to match SVG, use same function as video
        if (typeof resizeVideoToSvg === 'function') {
            resizeVideoToSvg(img);
        }

        // Optional size in percentage of SVG/container
        if (opts.sizePct && Number.isFinite(+opts.sizePct)) {
            const pct = Math.max(10, Math.min(100, +opts.sizePct));
            img.style.width = (img.offsetWidth * pct / 100) + 'px';
            img.style.height = (img.offsetHeight * pct / 100) + 'px';
        }

        if (mapImageCloseButton && img.parentElement && img.parentElement.contains(mapImageCloseButton)) {
            mapImageCloseButton.style.display = 'block';
        }

        img.onerror = (e) => {
            console.error('[Map] Error loading image for map window:', imgSrc, e);
            if (typeof toastr !== 'undefined') {
                toastr.error('Error loading image for map window');
            }
        };
    } catch (error) {
        console.error('[Map] Error in showMapImage:', error);
        if (typeof toastr !== 'undefined') {
            toastr.error(`Image error: ${error.message}`);
        }
    }
}

// ===== 🎬 VIDEO IN MAP WINDOW =====
let mapVideoElement = null;
let mapVideoCloseButton = null;

/**
* Returns or creates video element inside map window, sized to SVG
*/
function getOrCreateMapVideoElement() {
    const container = document.querySelector('#map .dragContent') || document.getElementById('map');
    if (!container) return null;

    // Already exists in correct container
    if (mapVideoElement && container.contains(mapVideoElement)) {
        resizeVideoToSvg(mapVideoElement);
        if (mapVideoCloseButton && !container.contains(mapVideoCloseButton)) {
            container.appendChild(mapVideoCloseButton);
        }
        return mapVideoElement;
    }

    // Create video
    const video = document.createElement('video');
    video.id = 'mapVideoPlayer';
    video.controls = true;
    video.playsInline = true;

    video.style.position = 'absolute';
    video.style.top = '0';
    video.style.left = '0';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.borderRadius = '8px';
    video.style.background = 'rgba(0,0,0,.3)';
    video.style.objectFit = 'contain';
    video.style.zIndex = '10';

    container.appendChild(video);
    mapVideoElement = video;

    // Close button (one for entire video)
    if (!mapVideoCloseButton) {
        const btn = document.createElement('button');
        btn.id = 'mapVideoClose';
        btn.textContent = 'Close';

        btn.style.position = 'absolute';
        btn.style.top = '48px';          // Button position in player window
        btn.style.right = '12px';
        btn.style.zIndex = '11';

        btn.style.padding = '6px 14px';  // Button size
        btn.style.fontSize = '14px';     // Font size

        btn.style.border = 'none';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.style.background = 'rgba(0, 0, 0, 0.7)';
        btn.style.color = '#fff';
        btn.style.boxShadow = '0 2px 4px rgba(0,0,0,0.4)';

        btn.addEventListener('click', () => {
            stopCurrentMapVideo();
        });

        mapVideoCloseButton = btn;
    }

    container.appendChild(mapVideoCloseButton);
    return video;
}

/**
* Resizes video to match SVG container size
*/
function resizeVideoToSvg(video) {
    if (!video) return;
    const svgContainer = document.getElementById('svg-container');
    if (!svgContainer) {
        // Fallback: full container size
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.top = '0';
        video.style.left = '0';
        return;
    }

    const svgRect = svgContainer.getBoundingClientRect();
    const containerRect = video.parentElement.getBoundingClientRect();

    if (svgRect.width > 0 && svgRect.height > 0) {
        video.style.width = svgRect.width + 'px';
        video.style.height = svgRect.height + 'px';
        video.style.top = (svgRect.top - containerRect.top) + 'px';
        video.style.left = (svgRect.left - containerRect.left) + 'px';
    }
}

/**
* Stops current video and clears src
*/
function stopCurrentMapVideo() {
    try {
        if (mapVideoElement) {
            // If video already removed from DOM, just reset reference
            if (!document.body || !document.body.contains(mapVideoElement)) {
                mapVideoElement = null;
            } else {
                mapVideoElement.pause();
                mapVideoElement.removeAttribute('src');
                mapVideoElement.load();
                mapVideoElement.style.display = 'none';
            }
        }

        if (mapVideoCloseButton && document.body && document.body.contains(mapVideoCloseButton)) {
            mapVideoCloseButton.style.display = 'none';
        }
    } catch (e) {
        console.error('[Map] Ошибка при остановке видео:', e);
    }
}

/**
* Plays video from extension movies folder
* @param {string} movieName - file name or relative path within movies
* @param {{muted?:boolean, loop?:boolean, autoplay?:boolean, sizePct?:number}} opts
*/
async function playMapVideo(movieName, opts = {}) {
    try {
        if (!movieName) return;

        let relativePath = movieName.trim();
        if (!relativePath.toLowerCase().startsWith('movies/')) {
            relativePath = `movies/${relativePath}`;
        }

        const lower = relativePath.toLowerCase();
        const hasExt =
            lower.endsWith('.mp4') ||
            lower.endsWith('.webm') ||
            lower.endsWith('.ogg') ||
            lower.endsWith('.m4v');

        if (!hasExt) {
            relativePath += '.mp4';
        }

        validateAssetPath(relativePath);
        const videoSrc = `${extensionFolderPath}/${relativePath}`;

        const video = getOrCreateMapVideoElement();
        if (!video) {
            if (typeof toastr !== 'undefined') {
                toastr.warning('Map window not open');
            }
            return;
        }

        // First correctly stop previous video
        if (video.src) {
            try {
                video.pause();
                video.removeAttribute('src');
                video.load();
            } catch (e) {
                console.error('[Map] Error clearing previous video:', e);
            }
        }

        video.style.display = 'block';
        if (mapVideoCloseButton) {
            mapVideoCloseButton.style.display = 'block';
        }

        video.src = videoSrc;
        video.muted = !!opts.muted;
        video.loop = !!opts.loop;
        video.autoplay = opts.autoplay !== false;

        resizeVideoToSvg(video);

        if (opts.sizePct && Number.isFinite(+opts.sizePct)) {
            const pct = Math.max(10, Math.min(100, +opts.sizePct));
            video.style.width = (video.offsetWidth * pct / 100) + 'px';
            video.style.height = (video.offsetHeight * pct / 100) + 'px';
        }

        video.onended = () => {
            if (mapSettings.debugMode) {
                console.log('[Map] Video finished:', videoSrc);
            }
        };

        const p = video.autoplay ? video.play() : null;
        if (p && typeof p.then === 'function') {
            p.catch(err => {
                console.error('[Map] Video autoplay rejected by browser policies:', err);
            });
        }

        if (!window._mapVideoResizeListener) {
            window._mapVideoResizeListener = () => resizeVideoToSvg(mapVideoElement);
            window.addEventListener('resize', window._mapVideoResizeListener);
        }
    } catch (error) {
        console.error('[Map] Error in playMapVideo:', error);
        if (typeof toastr !== 'undefined') {
            toastr.error(`Video error: ${error.message}`);
        }
    }
}

function createInteractivePath(shape) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', shape.path);
  path.setAttribute('id', shape.id);
  path.setAttribute('fill', 'transparent');
  path.setAttribute('class', 'svg-path');
  path.dataset.script = shape.script;
  path.dataset.originalColor = shape.color;
  
  if (mapSettings.enableTooltips && shape.tooltip) {
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = shape.tooltip;
    path.appendChild(title);
  }

// Create bound functions once and save to dataset
// This allows correct removal of handlers later
  const boundMouseOver = (e) => handleMouseOver.call(path, e);
  const boundMouseOut = (e) => handleMouseOut.call(path, e);
  
// Save function references for later removal
  path._boundMouseOver = boundMouseOver;
  path._boundMouseOut = boundMouseOut;
  path._boundClick = handleClick;

  path.addEventListener('click', handleClick);
  path.addEventListener('mouseover', boundMouseOver);
  path.addEventListener('mouseout', boundMouseOut);

  return path;
}

function handleMouseOver(event) {
  // Support for 3-digit hex (e.g. #F00)
  const hex = this.dataset.originalColor;
  let R, G, B;
  
  if (hex.length === 4) {
    R = parseInt(hex[1] + hex[1], 16);
    G = parseInt(hex[2] + hex[2], 16);
    B = parseInt(hex[3] + hex[3], 16);
  } else {
    R = parseInt(hex.substring(1, 3), 16);
    G = parseInt(hex.substring(3, 5), 16);
    B = parseInt(hex.substring(5, 7), 16);
  }

  this.style.fill = `rgba(${R}, ${G}, ${B}, ${mapSettings.hoverOpacity})`;
}

function handleMouseOut(event) {
  this.style.fill = 'transparent';
}

function handleClick(event) {
  try {
    executeSlashCommands(event.target.dataset.script);
  } catch (error) {
    console.error('[Map] Error executing script:', error);
    if (typeof toastr !== 'undefined') toastr.error('Command error');
  }
}

// ===== MAP CLEANUP FUNCTION =====
/**
* Clears map and removes event handlers to prevent memory leaks
*/
function clearMap() {
    const svgContainer = document.getElementById('svg-container');
    if (svgContainer) {
        const paths = svgContainer.querySelectorAll('.svg-path');
        paths.forEach(path => {
            if (path._boundClick) {
                path.removeEventListener('click', path._boundClick);
            }
            if (path._boundMouseOver) {
                path.removeEventListener('mouseover', path._boundMouseOver);
            }
            if (path._boundMouseOut) {
                path.removeEventListener('mouseout', path._boundMouseOut);
            }
            delete path._boundClick;
            delete path._boundMouseOver;
            delete path._boundMouseOut;
        });

        svgContainer.innerHTML = '';
    }

    extensionState.isMapLoaded = false;
    extensionState.currentMapElement = null;

    if (mapSettings.debugMode) {
        console.log('[Map] Map cleared');
    }
}

/**
* Initializes SVG map with background and interactive zones
* @param {Object} svgData - Object with backgroundImage and shapes
* @throws {Error} If container not found or initialization error occurs
*/
function getSvgContainer() {
  return /** @type {SVGSVGElement | null} */ (
    document.querySelector(SELECTORS.SVG_CONTAINER)
  );
}

function getMapSelect() {
  return /** @type {HTMLSelectElement | null} */ (
    document.querySelector(SELECTORS.MAP_SELECTIONS)
  );
}

// Example usage in initMap:
function initMap(svgData) {
  const svgElement = getSvgContainer();
  if (!svgElement) {
    console.error('[Map] SVG container not found');
    if (typeof toastr !== 'undefined') toastr.error('Map container not found');
    return;
  }

  try {
    // Clear previous map
    clearMap();
    
    const imageElement = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    const imagePath = resolveAssetPath(svgData.backgroundImage.file);
    
    imageElement.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', imagePath);
    imageElement.setAttribute('x', '0');
    imageElement.setAttribute('y', '0');
    imageElement.setAttribute('width', svgData.backgroundImage.width);
    imageElement.setAttribute('height', svgData.backgroundImage.height);
    imageElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    
    imageElement.addEventListener('error', () => {
      console.error('[Map] Error loading image:', imagePath);
      if (typeof toastr !== 'undefined') toastr.error('Error loading image');
    });
    
    svgElement.appendChild(imageElement);
    
    const width = parseInt(svgData.backgroundImage.width);
    const height = parseInt(svgData.backgroundImage.height);
    if (!isNaN(width) && !isNaN(height) && width > 0 && height > 0) {
      svgElement.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
    
    const fragment = document.createDocumentFragment();
    svgData.shapes.forEach(shape => {
      fragment.appendChild(createInteractivePath(shape));
    });
    svgElement.appendChild(fragment);
    
    extensionState.isMapLoaded = true;
    extensionState.currentMapElement = svgElement;
    if (mapSettings.debugMode) {
      console.log(`[Map] Initialization complete. Zones: ${svgData.shapes.length}`);
    }
  } catch (error) {
    console.error('[Map] Initialization error:', error);
    if (typeof toastr !== 'undefined') toastr.error('Map initialization error');
    extensionState.isMapLoaded = false;
  }
}

/// ===== UI MANAGEMENT =====
/**
* Normalizes input parameter (event/array/string) to map name string
* @param {*} input - Source value (event, array or string)
* @returns {string|null} Normalized map name or null
*/
function normalizeMapInput(input) {
    // Ignore click events
    if (input && typeof input === 'object' && (input.type === 'click' || input.originalEvent)) {
        return null;
    }
    
    // Convert array to string
    if (Array.isArray(input)) {
        return input.join(' ').trim() || null;
    }
    
    // Validate string
    if (typeof input === 'string') {
        return input.trim() || null;
    }
    
    return null;
}

/**
* Finds map in available list with partial match support
* @param {string} searchTerm - Search query
* @returns {string|null} Full map path or null
*/
function findMapByName(searchTerm) {
    if (!extensionState.availableMaps || extensionState.availableMaps.length === 0) {
        return null;
    }
    
    const search = searchTerm.toLowerCase();
    
    return extensionState.availableMaps.find(mapPath => {
        const mapLower = mapPath.toLowerCase();
        
        // Exact match
        if (mapLower === search) return true;
        
        // Match by filename without extension (maps/SillyTavern.json → SillyTavern)
        if (mapLower.endsWith('/' + search + '.json')) return true;
        if (mapLower === search + '.json') return true;
        
        /// Match by name with extension (maps/SillyTavern.json → SillyTavern.json)
        if (mapLower.endsWith('/' + search)) return true;
        if (mapLower === search) return true;
        
        return false;
    }) || null;
}

/**
* Resolves map name: either finds in index or uses as direct path
* @param {string} input - Map name or path
* @returns {string} Full path to map file
*/
function resolveMapPath(input) {
    if (!input) return null;
    
    const trimmed = input.trim();
    
    // Try to find in available maps
    const found = findMapByName(trimmed);
    if (found) {
        if (mapSettings.debugMode) console.log('[Map]  Map found in index:', found);
        return found;
    }
    
    // Fallback: use input as direct path
    let mapPath = trimmed;
    if (!mapPath.toLowerCase().endsWith('.json')) {
        mapPath += '.json';
    }
    
    if (mapSettings.debugMode) {
        console.warn('[Map] Map not found in index, using direct path:', mapPath);
    }
    
    return mapPath;
}

async function showMap(input) {
  try {
    // Check for jQuery presence
    if (typeof jQuery === 'undefined' || !$) {
      throw new Error('jQuery not found');
    }
    
    // Normalize input data
    const normalizedInput = normalizeMapInput(input);
    
    // If map name explicitly provided, try to find/resolve it
    let targetMap = normalizedInput
      ? resolveMapPath(normalizedInput)
      : extensionState.currentLoadedMap;
    
    if (!targetMap) {
      if (typeof toastr !== 'undefined') toastr.warning('Map not selected');
      return;
    }
    
    // Load and initialize
    makeMovable();
    const svgData = await loadMapData(targetMap);
    extensionState.currentLoadedMap = targetMap;
    
    if (svgData.mapSound) {
      await playMapSound(svgData.mapSound);
    }
    
    // Sync selector if it exists
    const select = $('#mapSelections');
    if (select.length > 0 && select.find(`option[value="${targetMap}"]`).length > 0) {
      select.val(targetMap);
    }
    
    initMap(svgData);
    if (typeof toastr !== 'undefined') toastr.success(`Map "${targetMap}" loaded`);
    
  } catch (error) {
    console.error('[Map] Error showing map:', error);
    let errorMsg = error.message;
    
    if (errorMsg.includes('404')) {
      errorMsg = `Map file not found (${error.message}). Check name and index.json`;
    }
    
    if (typeof toastr !== 'undefined') toastr.error(`Error: ${errorMsg}`);
    extensionState.lastError = error;
  }
}

function makeMovable(id = 'map') {
  try {
    if ($(`#${id}`).length > 0) {
      $(`#${id}`).show();
      return;
    }
    
    const template = $('#generic_draggable_template').html();
    if (!template) {
      console.error('[Map] Template not found');
      if (typeof toastr !== 'undefined') toastr.error('Error: window template not found');
      return;
    }
    
    const newElement = $(template);
    newElement.css('background-color', 'var(--SmartThemeBlurTintColor)');
    newElement.attr('forChar', id).attr('id', id);
    newElement.find('.drag-grabber').attr('id', `${id}header`);
    newElement.find('.dragTitle').text('Interactive Map');
    
    // Create SVG container 
    newElement.append('<svg id="svg-container" style="width: 100%; height: 100%;"></svg>');
    newElement.addClass('no-scrollbar');
    
    const closeButton = newElement.find('.dragClose');
    closeButton.attr('id', `${id}close`).attr('data-related-id', id);
    
    $('#dragMap').css('display', 'block');
    $('body').append(newElement);
    
    // Check for function before calling
    if (typeof loadMovingUIState === 'function') {
      loadMovingUIState();
    }
    
    $(`.draggable[forChar="${id}"]`).css('display', 'block');
    dragElement(newElement);
    
    $(`.draggable[forChar="${id}"] img`).on('dragstart', (e) => {
      e.preventDefault();
      return false;
    });
    
    if (mapSettings.debugMode) console.log(`[Map] Window created: ${id}`);
  } catch (error) {
    console.error('[Map] Ошибка создания окна:', error);
    if (typeof toastr !== 'undefined') toastr.error('Error creating map window');
  }
}

// ===== WINDOW CLOSE HANDLER =====
/**
* Sets up map window close handler
* Removes window and clears SVG state
*/
function setupCloseHandler() {
    // Delegate only for close elements inside map container
    $(document).on('click', '#map .dragClose', function (e) {
        e.stopPropagation();

        const relatedId = $(this).data('related-id') || 'map';
        const $element = $(`#${relatedId}`);

        if ($element.length === 0) {
            console.warn(`[Map] Element #${relatedId} not found`);
            return;
        }

        try {
            clearMap();
            stopCurrentMapAudio();
            stopCurrentMapImage();
            stopCurrentMapVideo?.();

            $element.off().remove();

            if (mapSettings.debugMode) {
                console.log(`[Map] Window closed: ${relatedId}`);
            }
        } catch (error) {
            console.error('[Map] Error closing window:', error);
        }
    });
}

/// Call once during extension initialization
let closeHandlerInitialized = false;

// In jQuery(() => { ... }):
if (!closeHandlerInitialized) {
    setupCloseHandler();
    closeHandlerInitialized = true;
}

// ===== HELPER FUNCTION FOR MAP NAME GENERATION =====
/**
* Converts map path to simple name without maps/ and .json
* Examples:
* 'Name.json' → 'Name'
* 'maps/Name.json' → 'Name'
* 'dungeons/city/Main.json' → 'Main'
* @param {string} mapPath - Map path
* @returns {string} Display label
*/
function getMapLabel(mapPath) {
  if (!mapPath) return 'Unknown';
  
  // Get filename only
  let filename = mapPath.includes('/') 
    ? mapPath.split('/').pop() 
    : mapPath;
  
// Remove .json extension
  if (filename.toLowerCase().endsWith('.json')) {
    filename = filename.slice(0, -5);
  }
  
  return filename;
}

// ===== MAP SELECTION INITIALIZATION =====
/**
* Initializes map selection dropdown
*/
async function initializeMapSelection() {
    try {
        const maps = await discoverAvailableMaps();
        const $select = $('#mapSelections');

        if ($select.length === 0) {
            console.warn('[Map] Map selection dropdown not found');
            return;
        }

        $select.empty();

        // Nice names via getMapLabel
        maps.forEach(map => {
            const label = getMapLabel(map);
            const $option = $('<option>')
                .val(map)
                .text(label);
            $select.append($option);
        });

        if (maps.length > 0) {
            extensionState.currentLoadedMap = maps[0];
            $select.val(maps[0]);
        }

        // Change handler
        $select.off('change').on('change', function () {
            extensionState.currentLoadedMap = $(this).val();
            if (mapSettings.debugMode) {
                console.log('[Map] Selected map:', extensionState.currentLoadedMap);
            }
        });

        if (mapSettings.debugMode) {
            console.log(`[Map] Selection initialization complete. Maps: ${maps.length}`);
        }
    } catch (error) {
        console.error('[Map] Selection initialization error:', error);
        if (typeof toastr !== 'undefined') {
            toastr.error('Error initializing map selection');
        }
    }
}

// ===== EXTENSION INITIALIZATION =====
jQuery(async () => {
  // Check for required dependencies
  if (typeof jQuery === 'undefined') {
    console.error('[Map] jQuery not found - extension cannot be initialized');
    return;
  }
  
  if (!document.getElementById('extensionsMenu')) {
    console.error('[Map] Extensions menu not found - extension cannot be initialized');
    return;
  }
  
  console.log('[Map] Extension initialization...');
  
   try {
    await initializeMapSelection();
    
    // Initialize closeHandler exactly once
        if (!closeHandlerInitialized) {
          setupCloseHandler();
          closeHandlerInitialized = true;
        }

// Button creation
const button = $(`
    <button id="map_start" type="button" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem">
        🌍 Last Selected Map
    </button>
`).css({
    fontFamily: 'var(--mainFontFamily), sans-serif',
    fontSize: 'var(--mainFontSize)',
    color: '#000',
});

$('#extensionsMenu').append(button);
$('#map_start').on('click', showMap);

// ===== COMMON UTILITIES FOR SLASH COMMANDS =====
/**
* Brings args/value to single argument string.
* @param {unknown} args
* @param {unknown} value
* @returns {string}
*/
function getRawArgs(args, value) {
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }

    if (Array.isArray(args)) {
        return args.join(' ').trim();
    }

    if (typeof args === 'string') {
        return args.trim();
    }

    return '';
}

 // 🌍 Register show map command
    registerSlashCommand(
        'showmap',
        async (args, value) => {
            try {
                await showMap(value || args);
                return '';
            } catch (error) {
                console.error('[Map] Error in /showmap command:', error);
                return `Ошибка: ${error.message}`;
            }
        },
        [],
        'Show interactive map (/showmap [map_name])',
        true,
        true
    );

// 🔈🎵 Load audio file: /showmap_sound sound_name [sound=other_file_name]
registerSlashCommand(
    'showmap_sound',
    async (args, value) => {
        try {
            let raw = getRawArgs(args, value);

            if (!raw) {
                return 'Usage: /showmap_sound [sound_name] [sound=other_file_name]';
            }

            // --- parse optional sound name via named argument sound=... ---
            let soundName = null;
            let soundPart = raw;

            // sound="..." (double quotes)
            let m = soundPart.match(/sound=\"([^\"]+)\"/i);

            if (!m) {
                // sound='...' (single quotes)
                m = soundPart.match(/sound='([^']+)'/i);
            }

            if (!m) {
                // sound=without_spaces
                m = soundPart.match(/sound=([^\s]+)/i);
            }

            if (m) {
                soundName = m[1];
                // remove this fragment from string
                soundPart = soundPart.replace(m[0], '').trim();
            }

            // Everything remaining is base sound name
            const baseName = soundPart;

            if (!baseName && !soundName) {
                return 'Sound name not specified. Example: /showmap_sound "Secluded corner"';
            }

            // If separate sound name not provided, use baseName
            if (!soundName) {
                soundName = baseName;
            }

            // Only play sound, do NOT touch map
            await playMapSound(soundName);
            return '';
        } catch (error) {
            console.error('[Map] Error in /showmap_sound command:', error);
            return `Ошибка: ${error.message}`;
        }
    },
    [],
    'Play sound from sounds folder (/showmap_sound [sound_name] [sound=other_file_name])',
    true,
    true
);


// 🔈🔇 Slash command to stop audio: /stopsound
registerSlashCommand(
    'stopsound',
    async (args, value) => {
        try {
            stopCurrentMapAudio();
            if (mapSettings.debugMode) {
                console.log('[Map] Sound stopped');
            }
            if (typeof toastr !== 'undefined') {
                toastr.success('Map sound stopped');
            }
            return '';
        } catch (error) {
            console.error('[Map] Error in /stopsound command:', error);
            return `Error: ${error.message}`;
        }
    },
    [],
    'Stop map audio playback',
    true,
    true
);

// 🖼 Show image in map window from images folder: /showmap_image file [size=80]
registerSlashCommand(
    'showmap_image',
    async (args, value) => {
        try {
            let raw = getRawArgs(args, value);

            if (!raw) {
                return 'Usage: /showmap_image filename [size=80]';
            }

            // Parse size option
            const opt = {};
            const mSize = raw.match(/size=(\d{1,3})/i);

            if (mSize) {
                opt.sizePct = parseInt(mSize[1], 10);
                raw = raw.replace(mSize[0], '').trim();
            }

            await showMapImage(raw, opt);
            return '';
        } catch (e) {
            console.error('[Map] Error in /showmap_image command:', e);
            return `Ошибка: ${e.message}`;
        }
    },
    [],
    'Show image in map window from images folder (/showmap_image file [size=80])',
    true,
    true
);


// 🖼🛑 Hide image
registerSlashCommand(
    'stopimage',
    async () => {
        try {
            stopCurrentMapImage();
            if (typeof toastr !== 'undefined') {
                toastr.success('Image hidden');
            }
            return '';
        } catch (e) {
            console.error('[Map] Error in /stopimage command:', e);
            return `Ошибка: ${e.message}`;
        }
    },
    [],
    'Hide image in map window',
    true,
    true
);

// 🎬 Show video in map window from movies folder: /showmap_video file [muted=1] [loop=1] [size=40]
registerSlashCommand(
    'showmap_video',
    async (args, value) => {
        try {
            let raw = getRawArgs(args, value);

            if (!raw) {
                return 'Usage: /showmap_video filename [muted=1] [loop=1] [size=40]';
            }

            // Parse options
            const opt = {};

            const mMuted = raw.match(/muted=(\d+)/i);
            if (mMuted) {
                opt.muted = mMuted[1] === '1';
                raw = raw.replace(mMuted[0], '').trim();
            }

            const mLoop = raw.match(/loop=(\d+)/i);
            if (mLoop) {
                opt.loop = mLoop[1] === '1';
                raw = raw.replace(mLoop[0], '').trim();
            }

            const mSize = raw.match(/size=(\d{1,3})/i);
            if (mSize) {
                opt.sizePct = parseInt(mSize[1], 10);
                raw = raw.replace(mSize[0], '').trim();
            }

            // Per request — do NOT load map and do NOT call showMap
            await playMapVideo(raw, opt);
            return '';
        } catch (e) {
            console.error('[Map]  Error in /showmap_video command:', e);
            return `Ошибка: ${e.message}`;
        }
    },
    [],
    'Show video in map window from movies folder (/showmap_video file [muted=1] [loop=1] [size=40])',
    true,
    true
);

// 🎬🛑 Stop video
registerSlashCommand(
    'stopvideo',
    async () => {
        try {
            stopCurrentMapVideo();
            if (typeof toastr !== 'undefined') toastr.success('Video stopped');
            return '';
        } catch (e) {
            console.error('[Map]  Error in /stopvideo command:', e);
            return `Ошибка: ${e.message}`;
        }
    },
    [],
    'Stop video in map window',
    true,
    true
);

    // UI settings
        const settingsHtml = `
            <div class="map_settings">
        <div class="inline-drawer">
          <div class="inline-drawer-toggle inline-drawer-header">
            <b>🌍 Interactive Maps</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
          </div>
          <div class="inline-drawer-content">
            <div class="flex-container flexnowrap">
              <label for="mapSelections" style="margin-right: 10px; white-space: nowrap;">Select map from maps folder:</label>
              <select id="mapSelections" name="map-selection" class="flex1 text_pole">
                <option value="">Loading...</option>
              </select>
            </div>
            
            <div class="flex-container flexnowrap" style="margin-top: 10px; gap: 10px;">
              <div id="map_load" class="menu_button menu_button_icon" style="flex: 1;">
                <div class="fa-solid fa-folder-open"></div>
                <span>Load Map</span>
              </div>
              <div id="map_refresh" class="menu_button menu_button_icon" style="flex: 1;">
                <div class="fa-solid fa-refresh"></div>
                <span>Refresh</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    $('#extensions_settings2').append(settingsHtml);
    
    $('#map_load').on('click', showMap);
    $('#map_refresh').on('click', async () => {
      if (typeof toastr !== 'undefined') toastr.info('Refreshing map list...');
      
      mapCache.clear();
      extensionState.availableMaps = [];
      await initializeMapSelection();
      
      if (typeof toastr !== 'undefined') toastr.success('Maps refreshed!');
    });

    console.log(`[SillyTavern-Interactive Map] ✅ v${EXTENSION_VERSION} initialized`);

  } catch (error) {
    console.error('[Map] Initialization error:', error);
    if (typeof toastr !== 'undefined') {
      toastr.error('Extension initialization error');
    }
  }
});