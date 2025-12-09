/**
 * SillyTavern-Interactive Map Extension - ВЕРСИЯ 1.0 Beta
 * Основной модуль расширения для интерактивных карт
 * 
 * Функциональность:
 * - Загрузка и отображение интерактивных карт
 * - Выполнение STScript команд при клике на зоны карты 
 * - Автоматическое обнаружение карт в папке "maps" через index.json
 * - Поддержка множества карт с динамическим выбором
 * - Возможность вкладывания карт одна в другую с переходом по уровням
 * - Валидация структуры данных карт
 */

const EXTENSION_VERSION = '1.0 Beta';

import { loadMovingUIState } from '../../../power-user.js';
import { dragElement } from '../../../RossAscends-mods.js';
import { registerSlashCommand, executeSlashCommands } from '../../../slash-commands.js';

// ===== КОНФИГУРАЦИЯ =====
const extensionName = 'SillyTavern-Interactive Map';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const DEFAULT_MAP = 'SillyTavern.json'; // Вынесено в константу

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
  defaultMap: DEFAULT_MAP // Добавлено в настройки
};

const mapCache = new Map();

const extensionState = {
  currentLoadedMap: null,
  availableMaps: [],
  isMapLoaded: false,
  lastError: null,
  currentMapElement: null, // Используется реально
  // svgContainer: null,  ← УДАЛЕНИЯ: каждый раз ищется через getElementById
};

// ===== ВАЛИДАЦИЯ =====
/** 
 * Полная валидация структуры карты.
 * @param {unknown} data
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateMapData(data) {
    /** @type {string[]} */
    const errors = [];

    if (!data || typeof data !== 'object') {
        return { valid: false, errors: ['Данные карты должны быть объектом'] };
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
        errors.push('backgroundImage.file: обязателен и должен быть строкой');
    }

    const width = Number(bg?.width);
    const height = Number(bg?.height);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        errors.push('backgroundImage.width/height: должны быть положительными числами');
    }

    if (!Array.isArray(map.shapes) || map.shapes.length === 0) {
        errors.push('shapes: должен быть непустым массивом');
    } else {
        map.shapes.forEach((shape, i) => {
            validateShape(shape, i, errors);
        });
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Валидация отдельной фигуры карты.
 * @param {unknown} shape
 * @param {number} index
 * @param {string[]} errors
 */
function validateShape(shape, index, errors) {
    if (!shape || typeof shape !== 'object') {
        errors.push(`Shape[${index}]: должен быть объектом`);
        return;
    }

    const s = /** @type {MapShape} */ (shape);
    const prefix = `Shape[${index}]`;

    if (!s.id || !s.path || !s.color || !s.script) {
        errors.push(`${prefix}: отсутствуют обязательные поля (id, path, color, script)`);
    }

    if (typeof s.script !== 'string') {
        errors.push(`${prefix}.script: должен быть строкой`);
    }

    if (typeof s.path !== 'string') {
        errors.push(`${prefix}.path: должен быть строкой`);
    }

    if (!isValidColor(s.color)) {
        errors.push(`${prefix}.color: некорректный цвет "${s.color}"`);
    }
}

function isValidColor(color) {
  return /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color);
}

// ===== ЗАЩИТА ОТ PATH TRAVERSAL =====
/**
 * Защита от path traversal атак
 * @param {string} filePath - Путь к файлу для проверки
 * @throws {Error} Если путь содержит опасные последовательности
 * @returns {boolean} true если путь безопасен
 */
function validateAssetPath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Путь должен быть строкой');
  }
  
  // Запретить выход за пределы папки
  if (filePath.includes('..') || 
      filePath.startsWith('/') || 
      filePath.startsWith('\\') ||
      filePath.includes('\\\\')) {
    throw new Error(`Недопустимый путь к файлу: ${filePath}`);
  }
  
  // Дополнительная проверка на абсолютные пути
  if (/^[a-zA-Z]:/.test(filePath)) {
    throw new Error(`Абсолютные пути запрещены: ${filePath}`);
  }
  
  return true;
}

// ===== ВСПОМОГАТЕЛЬНЫЕ УТИЛИТЫ =====
/**
 * Загружает JSON с таймаутом и правильной очисткой ресурсов
 */
async function fetchJsonWithTimeout(url, {
    timeout = 10000,
    init = {},
    treatNotOkAsEmpty = false,
    timeoutMessage = 'Timeout при загрузке ресурса',
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
            throw new Error(`Ошибка парсинга JSON: ${parseError.message}`);
        }

        return data;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(timeoutMessage);
        }
        throw error;
    } finally {
        // Гарантированная очистка таймаута
        clearTimeout(timeoutId);
    }
}

// ===== ЗАГРУЗКА КАРТ =====
async function tryLoadMapsFromIndex() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), mapSettings.indexTimeout);
  
  try {
    const response = await fetch(`${extensionFolderPath}/index.json`, {
      cache: 'no-cache',
      signal: controller.signal
    });
    
    // Очищаем только ОДИН раз при успехе
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      return [];
    }
    
    let index;
    try {
      index = await response.json();
    } catch (parseError) {
      console.debug('[Map] Ошибка парсинга index.json:', parseError);
      return [];
    }
    
    const maps = Array.isArray(index) ? index : (index.maps || []);
    if (mapSettings.debugMode && maps.length > 0) {
      console.log('[Map] Загружены карты:', maps);
    }
    
    return maps;
    
  } catch (fetchError) {
    // Очищаем таймаут только если ещё не был очищен
    clearTimeout(timeoutId);
    
    if (fetchError.name === 'AbortError') {
      console.debug('[Map] Timeout при загрузке index.json');
    } else {
      console.debug('[Map] Ошибка загрузки index.json (это нормально):', fetchError.message);
    }
    
    return [];
  }
}

async function discoverAvailableMaps() {
  try {
    const indexedMaps = await tryLoadMapsFromIndex();
    extensionState.availableMaps = indexedMaps.length > 0 
      ? indexedMaps 
      : [mapSettings.defaultMap]; // Использование константы
    return extensionState.availableMaps;
  } catch (error) {
    console.error('[Map] Ошибка обнаружения карт:', error);
    extensionState.availableMaps = [mapSettings.defaultMap];
    return [mapSettings.defaultMap];
  }
}

/**
 * Загружает данные карты из файла или кэша
 * @param {string} mapName - Имя/путь файла карты (относительно папки расширения)
 * @returns {Promise<Object>} Данные карты, прошедшие валидацию
 * @throws {Error} При таймауте, HTTP-ошибке или ошибке валидации
 */
async function loadMapData(mapName) {
    if (mapCache.has(mapName)) {
        if (mapSettings.debugMode) console.log('[Map] Загрузка из кэша:', mapName);
        return mapCache.get(mapName);
    }

    try {
        validateAssetPath(mapName);
        const mapPath = `${extensionFolderPath}/${mapName}`;
        
        const data = await fetchJsonWithTimeout(mapPath, {
            timeout: mapSettings.fetchTimeout,
            timeoutMessage: `Timeout при загрузке карты: ${mapName}`,
            treatNotOkAsEmpty: false,
        });

        const validation = validateMapData(data);
        if (!validation.valid) {
            throw new Error(`Ошибка валидации: ${validation.errors.join('; ')}`);
        }

        // Управление кэшем
        if (mapCache.size >= mapSettings.maxMapCache) {
            const firstKey = mapCache.keys().next().value;
            mapCache.delete(firstKey);
        }
        mapCache.set(mapName, data);

        if (mapSettings.debugMode) console.log('[Map] Карта загружена:', mapName);
        return data;
    } catch (error) {
        extensionState.lastError = error;
        throw error;
    }
}

// ===== ВИЗУАЛИЗАЦИЯ =====
function resolveAssetPath(filePath) {
  // Проверка безопасности пути
  validateAssetPath(filePath);
  
  if (filePath.startsWith('scripts/')) {
    return filePath;
  }
  return `${extensionFolderPath}/${filePath}`;
}

// ===== 🔈 АУДИО СОПРОВОЖДЕНИЕ КАРТ =====

let mapAudioElement = null;

/**
 * Возвращает или создаёт скрытый audio элемент для карт
 * @returns {HTMLAudioElement} Audio элемент
 */
function getOrCreateMapAudioElement() {
  // Проверяем, существует ли элемент ещё в DOM
  if (mapAudioElement && document.body.contains(mapAudioElement)) {
    return mapAudioElement;
  }
  
  const audio = document.createElement('audio');
  audio.id = 'mapSoundPlayer';
  audio.style.display = 'none';
  audio.preload = 'auto';
  // audio.loop = true; // включите, если нужно зацикливание
  
  document.body.appendChild(audio);
  mapAudioElement = audio;
  
  return audio;
}

/**
 * Останавливает текущее аудио, если оно играет
 */
function stopCurrentMapAudio() {
  if (!mapAudioElement || !document.body.contains(mapAudioElement)) {
    return;
  }
  
  try {
    mapAudioElement.pause();
    mapAudioElement.currentTime = 0;
  } catch (error) {
    console.error('[Map] Ошибка при остановке аудио:', error);
  }
}

/**
 * Проигрывает аудиофайл из папки sounds расширения
 * @param {string} soundFileName - имя файла или относительный путь внутри sounds
 * @returns {Promise<void>}
 */
async function playMapSound(soundFileName) {
    try {
        if (!soundFileName) return;

        let relativePath = soundFileName.trim();

        // Гарантируем, что путь указывает в папку sounds
        if (!relativePath.toLowerCase().startsWith('sounds/')) {
            relativePath = `sounds/${relativePath}`;
        }

        // Если нет расширения — добавляем .mp3 по умолчанию
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

        // Проверка безопасности относительного пути внутри расширения
        validateAssetPath(relativePath);

        const audioSrc = `${extensionFolderPath}/${relativePath}`;
        const audio = getOrCreateMapAudioElement();

        // Подготовка нового трека
        stopCurrentMapAudio();
        audio.src = audioSrc;
        audio.currentTime = 0;

        audio.onended = () => {
            if (mapSettings.debugMode) {
                console.log('[Map] Аудио закончилось:', audioSrc);
            }
        };

        audio.onerror = (e) => {
            const msg = `Ошибка аудиофайла карты: ${audioSrc}`;
            console.error('[Map] Ошибка аудио:', msg, e);
            if (typeof toastr !== 'undefined') {
                toastr.error(msg);
            }
        };

        if (mapSettings.debugMode) {
            console.log('[Map] Проигрываю аудио:', audioSrc);
        }

        const playPromise = audio.play();
        if (playPromise && typeof playPromise.then === 'function') {
            playPromise.catch(err => {
                console.error('[Map] Ошибка при запуске воспроизведения:', err);
                if (typeof toastr !== 'undefined') {
                    toastr.error('Не удалось запустить воспроизведение звука карты');
                }
            });
        }
    } catch (error) {
        console.error('[Map] Ошибка в playMapSound:', error);
        if (typeof toastr !== 'undefined') {
            toastr.error(`Ошибка звука: ${error.message}`);
        }
    }
}

// ===== 🖼 ИЗОБРАЖЕНИЕ В ОКНЕ КАРТЫ =====
let mapImageElement = null;
let mapImageCloseButton = null;

/**
 * Возвращает или создаёт img элемент внутри окна карты
 */
function getOrCreateMapImageElement() {
    const container = document.querySelector('#map .dragContent') || document.getElementById('map');
    if (!container) return null;

    // Уже существует в нужном контейнере
    if (mapImageElement && container.contains(mapImageElement)) {
        // Убедимся, что кнопка тоже в контейнере
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
    img.style.zIndex = '9'; // ниже видео (у видео 10), но поверх SVG
    img.style.display = 'none';
    container.appendChild(img);
    mapImageElement = img;

    // Кнопка "Закрыть" (одна на всё изображение)
    if (!mapImageCloseButton) {
        const btn = document.createElement('button');
        btn.id = 'mapImageClose';
        btn.textContent = 'Закрыть';
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
 * Скрывает текущее изображение
 */
function stopCurrentMapImage() {
    try {
        // Прячем само изображение, если оно есть в DOM
        if (mapImageElement && document.body && document.body.contains(mapImageElement)) {
            mapImageElement.removeAttribute('src');
            mapImageElement.style.display = 'none';
        }

        // Прячем кнопку "Закрыть", если она есть в DOM
        if (mapImageCloseButton && document.body && document.body.contains(mapImageCloseButton)) {
            mapImageCloseButton.style.display = 'none';
        }
    } catch (e) {
        console.error('[Map] Ошибка при остановке изображения:', e);
    }
}

/**
 * Показывает изображение из папки images расширения
 * Поддерживаются: .png, .jpg, .jpeg, .webp, .gif
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
            // по умолчанию .png
            relativePath += '.png';
        }

        // Проверка безопасности пути
        validateAssetPath(relativePath);

        const imgSrc = `${extensionFolderPath}/${relativePath}`;
        const img = getOrCreateMapImageElement();
        if (!img) {
            if (typeof toastr !== 'undefined') {
                toastr.warning('Окно карты не открыто');
            }
            return;
        }

        // Спрятать/очистить предыдущее изображение и кнопку
        stopCurrentMapImage();

        img.style.display = 'block';
        img.src = imgSrc;

        // Подгон под SVG, используем ту же функцию, что и для видео
        if (typeof resizeVideoToSvg === 'function') {
            resizeVideoToSvg(img);
        }

        // Необязательный размер в процентах от SVG/контейнера
        if (opts.sizePct && Number.isFinite(+opts.sizePct)) {
            const pct = Math.max(10, Math.min(100, +opts.sizePct));
            img.style.width = (img.offsetWidth * pct / 100) + 'px';
            img.style.height = (img.offsetHeight * pct / 100) + 'px';
        }

        if (mapImageCloseButton && img.parentElement && img.parentElement.contains(mapImageCloseButton)) {
            mapImageCloseButton.style.display = 'block';
        }

        img.onerror = (e) => {
            console.error('[Map] Ошибка загрузки изображения для окна карты:', imgSrc, e);
            if (typeof toastr !== 'undefined') {
                toastr.error('Ошибка загрузки изображения для окна карты');
            }
        };
    } catch (error) {
        console.error('[Map] Ошибка в showMapImage:', error);
        if (typeof toastr !== 'undefined') {
            toastr.error(`Ошибка изображения: ${error.message}`);
        }
    }
}

// ===== 🎬 ВИДЕО В ОКНЕ КАРТЫ =====
let mapVideoElement = null;
let mapVideoCloseButton = null;

/**
 * Возвращает или создаёт video элемент внутри окна карты, подгонанный под размер SVG
 */
function getOrCreateMapVideoElement() {
    const container = document.querySelector('#map .dragContent') || document.getElementById('map');
    if (!container) return null;

    // Уже существует в нужном контейнере
    if (mapVideoElement && container.contains(mapVideoElement)) {
        resizeVideoToSvg(mapVideoElement);
        if (mapVideoCloseButton && !container.contains(mapVideoCloseButton)) {
            container.appendChild(mapVideoCloseButton);
        }
        return mapVideoElement;
    }

    // Создаём видео
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

    // Кнопка "Закрыть" (одна на всё видео)
    if (!mapVideoCloseButton) {
        const btn = document.createElement('button');
        btn.id = 'mapVideoClose';
        btn.textContent = 'Закрыть';

        btn.style.position = 'absolute';
        btn.style.top = '48px';          // Положение кнопки в окне проигрывателя 
        btn.style.right = '12px';
        btn.style.zIndex = '11';

        btn.style.padding = '6px 14px';  // Размер кнопки
        btn.style.fontSize = '14px';     // Размер шрифта

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
 * Подгоняет видео под размер SVG контейнера
 */
function resizeVideoToSvg(video) {
    if (!video) return;
    const svgContainer = document.getElementById('svg-container');
    if (!svgContainer) {
        // Fallback: полный размер контейнера
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
 * Останавливает текущее видео и очищает src
 */
function stopCurrentMapVideo() {
    try {
        if (mapVideoElement) {
            // Если видео уже удалено из DOM, просто сбросим ссылку
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
 * Проигрывает видео из папки movies расширения
 * @param {string} movieName - имя файла или относительный путь внутри movies
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
                toastr.warning('Окно карты не открыто');
            }
            return;
        }

        // Сначала корректно остановим предыдущее
        if (video.src) {
            try {
                video.pause();
                video.removeAttribute('src');
                video.load();
            } catch (e) {
                console.error('[Map] Ошибка при очистке предыдущего видео:', e);
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
                console.log('[Map] Видео закончилось:', videoSrc);
            }
        };

        const p = video.autoplay ? video.play() : null;
        if (p && typeof p.then === 'function') {
            p.catch(err => {
                console.error('[Map] Автозапуск видео отклонён политиками браузера:', err);
            });
        }

        if (!window._mapVideoResizeListener) {
            window._mapVideoResizeListener = () => resizeVideoToSvg(mapVideoElement);
            window.addEventListener('resize', window._mapVideoResizeListener);
        }
    } catch (error) {
        console.error('[Map] Ошибка в playMapVideo:', error);
        if (typeof toastr !== 'undefined') {
            toastr.error(`Ошибка видео: ${error.message}`);
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

  // Создаём bound-функции один раз и сохраняем их в dataset
  // Это позволит корректно удалять обработчики позже
  const boundMouseOver = (e) => handleMouseOver.call(path, e);
  const boundMouseOut = (e) => handleMouseOut.call(path, e);
  
  // Сохраняем ссылки на функции, чтобы потом удалить точно такие же
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
    console.error('[Map] Ошибка выполнения скрипта:', error);
    if (typeof toastr !== 'undefined') toastr.error('Ошибка команды');
  }
}

// ===== ФУНКЦИЯ ОЧИСТКИ КАРТЫ =====
/**
 * Очищает карту и удаляет обработчики событий для предотвращения утечек памяти
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
        console.log('[Map] Карта очищена');
    }
}

/**
 * Инициализирует SVG-карту с фоном и интерактивными зонами
 * @param {Object} svgData - Объект с backgroundImage и shapes
 * @throws {Error} Если контейнер не найден или произошла ошибка инициализации
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

// пример использования в initMap:
function initMap(svgData) {
  const svgElement = getSvgContainer();
  if (!svgElement) {
    console.error('[Map] SVG контейнер не найден');
    if (typeof toastr !== 'undefined') toastr.error('Контейнер карты не найден');
    return;
  }

  try {
    // Очистить предыдущую карту
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
      console.error('[Map] Ошибка загрузки изображения:', imagePath);
      if (typeof toastr !== 'undefined') toastr.error('Ошибка загрузки изображения');
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
      console.log(`[Map] Инициализация завершена. Зон: ${svgData.shapes.length}`);
    }
  } catch (error) {
    console.error('[Map] Ошибка инициализации:', error);
    if (typeof toastr !== 'undefined') toastr.error('Ошибка инициализации карты');
    extensionState.isMapLoaded = false;
  }
}

// ===== УПРАВЛЕНИЕ UI =====
/**
 * Нормализует входной параметр (event/array/string) в строку имени карты
 * @param {*} input - Исходное значение (event, array или string)
 * @returns {string|null} Нормализованное имя карты или null
 */
function normalizeMapInput(input) {
    // Игнорируем click-события
    if (input && typeof input === 'object' && (input.type === 'click' || input.originalEvent)) {
        return null;
    }
    
    // Преобразуем массив в строку
    if (Array.isArray(input)) {
        return input.join(' ').trim() || null;
    }
    
    // Валидируем строку
    if (typeof input === 'string') {
        return input.trim() || null;
    }
    
    return null;
}

/**
 * Ищет карту в списке доступных с поддержкой частичного совпадения
 * @param {string} searchTerm - Поисковый запрос
 * @returns {string|null} Полный путь карты или null
 */
function findMapByName(searchTerm) {
    if (!extensionState.availableMaps || extensionState.availableMaps.length === 0) {
        return null;
    }
    
    const search = searchTerm.toLowerCase();
    
    return extensionState.availableMaps.find(mapPath => {
        const mapLower = mapPath.toLowerCase();
        
        // Точное совпадение
        if (mapLower === search) return true;
        
        // Совпадение по имени файла без расширения (maps/SillyTavern.json → SillyTavern)
        if (mapLower.endsWith('/' + search + '.json')) return true;
        if (mapLower === search + '.json') return true;
        
        // Совпадение по имени с расширением (maps/SillyTavern.json → SillyTavern.json)
        if (mapLower.endsWith('/' + search)) return true;
        if (mapLower === search) return true;
        
        return false;
    }) || null;
}

/**
 * Разрешает имя карты: либо находит в индексе, либо использует как прямой путь
 * @param {string} input - Имя карты или путь
 * @returns {string} Полный путь к файлу карты
 */
function resolveMapPath(input) {
    if (!input) return null;
    
    const trimmed = input.trim();
    
    // Попытка найти в доступных картах
    const found = findMapByName(trimmed);
    if (found) {
        if (mapSettings.debugMode) console.log('[Map] Карта найдена в индексе:', found);
        return found;
    }
    
    // Fallback: используем ввод как прямой путь
    let mapPath = trimmed;
    if (!mapPath.toLowerCase().endsWith('.json')) {
        mapPath += '.json';
    }
    
    if (mapSettings.debugMode) {
        console.warn('[Map] Карта не найдена в индексе, используется прямой путь:', mapPath);
    }
    
    return mapPath;
}

async function showMap(input) {
  try {
    // Проверяем наличие jQuery
    if (typeof jQuery === 'undefined' || !$) {
      throw new Error('jQuery не найден');
    }
    
    // Нормализуем входные данные
    const normalizedInput = normalizeMapInput(input);
    
    // Если явно передано имя карты, пытаемся его найти/разрешить
    let targetMap = normalizedInput
      ? resolveMapPath(normalizedInput)
      : extensionState.currentLoadedMap;
    
    if (!targetMap) {
      if (typeof toastr !== 'undefined') toastr.warning('Карта не выбрана');
      return;
    }
    
    // Загружаем и инициализируем
    makeMovable();
    const svgData = await loadMapData(targetMap);
    extensionState.currentLoadedMap = targetMap;
    
    if (svgData.mapSound) {
      await playMapSound(svgData.mapSound);
    }
    
    // Синхронизируем селектор если он есть
    const select = $('#mapSelections');
    if (select.length > 0 && select.find(`option[value="${targetMap}"]`).length > 0) {
      select.val(targetMap);
    }
    
    initMap(svgData);
    if (typeof toastr !== 'undefined') toastr.success(`Карта "${targetMap}" загружена`);
    
  } catch (error) {
    console.error('[Map] Ошибка показа карты:', error);
    let errorMsg = error.message;
    
    if (errorMsg.includes('404')) {
      errorMsg = `Файл карты не найден (${error.message}). Проверьте имя и index.json`;
    }
    
    if (typeof toastr !== 'undefined') toastr.error(`Ошибка: ${errorMsg}`);
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
      console.error('[Map] Шаблон не найден');
      if (typeof toastr !== 'undefined') toastr.error('Ошибка: шаблон окна не найден');
      return;
    }
    
    const newElement = $(template);
    newElement.css('background-color', 'var(--SmartThemeBlurTintColor)');
    newElement.attr('forChar', id).attr('id', id);
    newElement.find('.drag-grabber').attr('id', `${id}header`);
    newElement.find('.dragTitle').text('Интерактивная карта');
    
    // Создание SVG контейнера 
    newElement.append('<svg id="svg-container" style="width: 100%; height: 100%;"></svg>');
    newElement.addClass('no-scrollbar');
    
    const closeButton = newElement.find('.dragClose');
    closeButton.attr('id', `${id}close`).attr('data-related-id', id);
    
    $('#dragMap').css('display', 'block');
    $('body').append(newElement);
    
    // Проверка наличия функции перед вызовом
    if (typeof loadMovingUIState === 'function') {
      loadMovingUIState();
    }
    
    $(`.draggable[forChar="${id}"]`).css('display', 'block');
    dragElement(newElement);
    
    $(`.draggable[forChar="${id}"] img`).on('dragstart', (e) => {
      e.preventDefault();
      return false;
    });
    
    if (mapSettings.debugMode) console.log(`[Map] Окно создано: ${id}`);
  } catch (error) {
    console.error('[Map] Ошибка создания окна:', error);
    if (typeof toastr !== 'undefined') toastr.error('Ошибка создания окна карты');
  }
}

// ===== ОБРАБОТЧИК ЗАКРЫТИЯ ОКНА =====
/**
 * Устанавливает обработчик закрытия окна карты
 * Удаляет окно и очищает состояние SVG
 */
function setupCloseHandler() {
    // Делегируем только для элементов закрытия внутри контейнера карты
    $(document).on('click', '#map .dragClose', function (e) {
        e.stopPropagation();

        const relatedId = $(this).data('related-id') || 'map';
        const $element = $(`#${relatedId}`);

        if ($element.length === 0) {
            console.warn(`[Map] Элемент #${relatedId} не найден`);
            return;
        }

        try {
            clearMap();
            stopCurrentMapAudio();
            stopCurrentMapImage();
            stopCurrentMapVideo?.();

            $element.off().remove();

            if (mapSettings.debugMode) {
                console.log(`[Map] Окно закрыто: ${relatedId}`);
            }
        } catch (error) {
            console.error('[Map] Ошибка при закрытии окна:', error);
        }
    });
}

// Вызвать один раз при инициализации расширения
let closeHandlerInitialized = false;

// В jQuery(() => { ... }):
if (!closeHandlerInitialized) {
    setupCloseHandler();
    closeHandlerInitialized = true;
}

// ===== ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ ГЕНЕРАЦИИ НАЗВАНИЙ КАРТ =====
/**
 * Преобразует путь карты в её простое название без maps/ и .json
 * Примеры:
 *   'Name.json' → 'Name'
 *   'maps/Name.json' → 'Name'
 *   'dungeons/city/Main.json' → 'Main'
 * @param {string} mapPath - Путь к карте
 * @returns {string} Отображаемый лейбл
 */
function getMapLabel(mapPath) {
  if (!mapPath) return 'Unknown';
  
  // Берём только имя файла
  let filename = mapPath.includes('/') 
    ? mapPath.split('/').pop() 
    : mapPath;
  
  // Удаляем расширение .json
  if (filename.toLowerCase().endsWith('.json')) {
    filename = filename.slice(0, -5);
  }
  
  return filename;
}

// ===== ИНИЦИАЛИЗАЦИЯ ВЫБОРА КАРТ =====
/**
 * Инициализирует dropdown выбора карт
 */
async function initializeMapSelection() {
    try {
        const maps = await discoverAvailableMaps();
        const $select = $('#mapSelections');

        if ($select.length === 0) {
            console.warn('[Map] Dropdown выбора карт не найден');
            return;
        }

        $select.empty();

        // Красивые названия через getMapLabel
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

        // Обработчик изменения выбора
        $select.off('change').on('change', function () {
            extensionState.currentLoadedMap = $(this).val();
            if (mapSettings.debugMode) {
                console.log('[Map] Выбрана карта:', extensionState.currentLoadedMap);
            }
        });

        if (mapSettings.debugMode) {
            console.log(`[Map] Инициализация выбора завершена. Карт: ${maps.length}`);
        }
    } catch (error) {
        console.error('[Map] Ошибка инициализации выбора:', error);
        if (typeof toastr !== 'undefined') {
            toastr.error('Ошибка инициализации выбора карт');
        }
    }
}

// ===== ИНИЦИАЛИЗАЦИЯ РАСШИРЕНИЯ =====
jQuery(async () => {
  // Проверка необходимых зависимостей
  if (typeof jQuery === 'undefined') {
    console.error('[Map] jQuery не найден - расширение не может быть инициализировано');
    return;
  }
  
  if (!document.getElementById('extensionsMenu')) {
    console.error('[Map] Меню расширений не найдено - расширение не может быть инициализировано');
    return;
  }
  
  console.log('[Map] Инициализация расширения...');
  
   try {
    await initializeMapSelection();
    
    // Инициализируем closeHandler ровно один раз
        if (!closeHandlerInitialized) {
          setupCloseHandler();
          closeHandlerInitialized = true;
        }

// Создание кнопки
const button = $(`
    <button id="map_start" type="button" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem">
        🌍 Последняя выбранная карта
    </button>
`).css({
    fontFamily: 'var(--mainFontFamily), sans-serif',
    fontSize: 'var(--mainFontSize)',
    color: '#000',
});

$('#extensionsMenu').append(button);
$('#map_start').on('click', showMap);

// ===== ОБЩИЕ УТИЛИТЫ ДЛЯ SLASH-КОМАНД =====

/**
 * Приводит args/value к одной строке аргументов.
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

 // 🌍 Регистрация команды показа карты
    registerSlashCommand(
        'showmap',
        async (args, value) => {
            try {
                await showMap(value || args);
                return '';
            } catch (error) {
                console.error('[Map] Ошибка команды /showmap:', error);
                return `Ошибка: ${error.message}`;
            }
        },
        [],
        'Показать интерактивную карту (/showmap [имя_карты])',
        true,
        true
    );

// 🔈🎵 Загрузка аудио файла: /showmap_sound имя_звука [sound=имя_другого_файла]
registerSlashCommand(
    'showmap_sound',
    async (args, value) => {
        try {
            let raw = getRawArgs(args, value);

            if (!raw) {
                return 'Использование: /showmap_sound [имя_звука] [sound=имя_другого_файла]';
            }

            // --- разбор опционального имени звука через named-аргумент sound=... ---
            let soundName = null;
            let soundPart = raw;

            // sound="..." (двойные кавычки)
            let m = soundPart.match(/sound=\"([^\"]+)\"/i);

            if (!m) {
                // sound='...' (одинарные кавычки)
                m = soundPart.match(/sound='([^']+)'/i);
            }

            if (!m) {
                // sound=без_пробелов
                m = soundPart.match(/sound=([^\s]+)/i);
            }

            if (m) {
                soundName = m[1];
                // выкидываем этот фрагмент из строки
                soundPart = soundPart.replace(m[0], '').trim();
            }

            // Всё, что осталось, считаем базовым именем звука
            const baseName = soundPart;

            if (!baseName && !soundName) {
                return 'Не указано имя звука. Пример: /showmap_sound "Secluded corner"';
            }

            // Если отдельное имя звука не передано, используем baseName
            if (!soundName) {
                soundName = baseName;
            }

            // Только проигрывание звука, карту НЕ трогаем
            await playMapSound(soundName);
            return '';
        } catch (error) {
            console.error('[Map] Ошибка команды /showmap_sound:', error);
            return `Ошибка: ${error.message}`;
        }
    },
    [],
    'Проиграть звук из папки sounds (/showmap_sound [имя_звука] [sound=имя_другого_файла])',
    true,
    true
);


// 🔈🔇 Слэш команда для прекращения воспроизведения аудиофайла: /stopsound
registerSlashCommand(
    'stopsound',
    async (args, value) => {
        try {
            stopCurrentMapAudio();
            if (mapSettings.debugMode) {
                console.log('[Map] Звук остановлен');
            }
            if (typeof toastr !== 'undefined') {
                toastr.success('Звук карты остановлен');
            }
            return '';
        } catch (error) {
            console.error('[Map] Ошибка команды /stopsound:', error);
            return `Ошибка: ${error.message}`;
        }
    },
    [],
    'Остановить проигрывание звука карты',
    true,
    true
);

// 🖼 Показ изображения в окне карты из папки images: /showmap_image файл [size=80]
registerSlashCommand(
    'showmap_image',
    async (args, value) => {
        try {
            let raw = getRawArgs(args, value);

            if (!raw) {
                return 'Использование: /showmap_image имя_файла [size=80]';
            }

            // Разбор опции size=NN
            const opt = {};
            const mSize = raw.match(/size=(\d{1,3})/i);

            if (mSize) {
                opt.sizePct = parseInt(mSize[1], 10);
                raw = raw.replace(mSize[0], '').trim();
            }

            await showMapImage(raw, opt);
            return '';
        } catch (e) {
            console.error('[Map] Ошибка команды /showmap_image:', e);
            return `Ошибка: ${e.message}`;
        }
    },
    [],
    'Показать изображение в окне карты из папки images (/showmap_image файл [size=80])',
    true,
    true
);


// 🖼🛑 Скрыть изображение
registerSlashCommand(
    'stopimage',
    async () => {
        try {
            stopCurrentMapImage();
            if (typeof toastr !== 'undefined') {
                toastr.success('Изображение скрыто');
            }
            return '';
        } catch (e) {
            console.error('[Map] Ошибка команды /stopimage:', e);
            return `Ошибка: ${e.message}`;
        }
    },
    [],
    'Скрыть изображение в окне карты',
    true,
    true
);

// 🎬 Показ видео в окне карты из папки movies: /showmap_video файл [muted=1] [loop=1] [size=40]
registerSlashCommand(
    'showmap_video',
    async (args, value) => {
        try {
            let raw = getRawArgs(args, value);

            if (!raw) {
                return 'Использование: /showmap_video имя_файла [muted=1] [loop=1] [size=40]';
            }

            // Разбор опций
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

            // По требованию — карту НЕ загружаем и НЕ вызываем showMap
            await playMapVideo(raw, opt);
            return '';
        } catch (e) {
            console.error('[Map] Ошибка команды /showmap_video:', e);
            return `Ошибка: ${e.message}`;
        }
    },
    [],
    'Показать видео в окне карты из папки movies (/showmap_video файл [muted=1] [loop=1] [size=40])',
    true,
    true
);

// 🎬🛑 Остановить видео
registerSlashCommand(
    'stopvideo',
    async () => {
        try {
            stopCurrentMapVideo();
            if (typeof toastr !== 'undefined') toastr.success('Видео остановлено');
            return '';
        } catch (e) {
            console.error('[Map] Ошибка команды /stopvideo:', e);
            return `Ошибка: ${e.message}`;
        }
    },
    [],
    'Остановить видео в окне карты',
    true,
    true
);

    // UI настройки
        const settingsHtml = `
            <div class="map_settings">
        <div class="inline-drawer">
          <div class="inline-drawer-toggle inline-drawer-header">
            <b>🌍 Интерактивные карты</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
          </div>
          <div class="inline-drawer-content">
            <div class="flex-container flexnowrap">
              <label for="mapSelections" style="margin-right: 10px; white-space: nowrap;">Выбор карты из папки maps:</label>
              <select id="mapSelections" name="map-selection" class="flex1 text_pole">
                <option value="">Загрузка...</option>
              </select>
            </div>
            
            <div class="flex-container flexnowrap" style="margin-top: 10px; gap: 10px;">
              <div id="map_load" class="menu_button menu_button_icon" style="flex: 1;">
                <div class="fa-solid fa-folder-open"></div>
                <span>Загрузить карту</span>
              </div>
              <div id="map_refresh" class="menu_button menu_button_icon" style="flex: 1;">
                <div class="fa-solid fa-refresh"></div>
                <span>Обновить</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    $('#extensions_settings2').append(settingsHtml);
    
    $('#map_load').on('click', showMap);
    $('#map_refresh').on('click', async () => {
      if (typeof toastr !== 'undefined') toastr.info('Обновление списка карт...');
      
      mapCache.clear();
      extensionState.availableMaps = [];
      await initializeMapSelection();
      
      if (typeof toastr !== 'undefined') toastr.success('Карты обновлены!');
    });

    console.log(`[SillyTavern-Interactive Map] ✅ v${EXTENSION_VERSION} инициализировано`);

  } catch (error) {
    console.error('[Map] Ошибка инициализации:', error);
    if (typeof toastr !== 'undefined') {
      toastr.error('Ошибка инициализации расширения');
    }
  }
});
