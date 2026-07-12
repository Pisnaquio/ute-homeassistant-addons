'use strict';

const fs = require('fs-extra');
const path = require('path');

require('dotenv').config();

const APP_ROOT = path.resolve(__dirname, '..');
const ADDON_OPTIONS_PATH = '/data/options.json';

function safeReadJson(filePath) {
  try {
    return fs.readJsonSync(filePath);
  } catch (error) {
    return null;
  }
}

const addonOptions = safeReadJson(ADDON_OPTIONS_PATH) || {};
const isAddonRuntime = fs.existsSync(ADDON_OPTIONS_PATH);

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return null;
}

function setEnvIfMissing(key, value) {
  if (firstNonEmpty(process.env[key]) !== null) return;
  const chosen = firstNonEmpty(value);
  if (chosen !== null) {
    process.env[key] = String(chosen);
  }
}

setEnvIfMissing('UTE_EMAIL', firstNonEmpty(addonOptions.ute_user, addonOptions.ute_email));
setEnvIfMissing('UTE_PASSWORD', addonOptions.ute_password);
setEnvIfMissing('DEBUG', addonOptions.debug === true ? 'true' : null);
setEnvIfMissing('TZ', addonOptions.timezone);

const runtimeName = firstNonEmpty(process.env.UTE_RUNTIME_NAME, 'ute');
const runtimeRoot = isAddonRuntime
  ? path.join('/data', runtimeName)
  : APP_ROOT;

const runtimePaths = {
  appRoot: APP_ROOT,
  runtimeRoot,
  dataDir: isAddonRuntime ? path.join(runtimeRoot, 'data') : path.join(APP_ROOT, 'data'),
  reportDir: isAddonRuntime ? path.join(runtimeRoot, 'reportes') : path.join(APP_ROOT, 'reportes'),
  logDir: isAddonRuntime ? path.join(runtimeRoot, 'logs') : path.join(APP_ROOT, 'logs'),
  tempDir: isAddonRuntime ? path.join(runtimeRoot, 'temp') : path.join(APP_ROOT, 'temp'),
};

function ensureRuntimeDirs() {
  fs.ensureDirSync(runtimePaths.dataDir);
  fs.ensureDirSync(runtimePaths.reportDir);
  fs.ensureDirSync(runtimePaths.logDir);
  fs.ensureDirSync(runtimePaths.tempDir);
}

function getChromiumLaunchOptions() {
  const options = {
    headless: process.env.UTE_HEADLESS !== 'false',
  };

  const executablePath = firstNonEmpty(
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
  );

  if (executablePath) {
    options.executablePath = executablePath;
  }

  const args = [];
  if (isAddonRuntime) {
    args.push('--no-sandbox', '--disable-dev-shm-usage');
  }

  if (args.length) {
    options.args = args;
  }

  return options;
}

module.exports = {
  addonOptions,
  ensureRuntimeDirs,
  getChromiumLaunchOptions,
  isAddonRuntime,
  runtimePaths,
};
