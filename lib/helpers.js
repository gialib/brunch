'use strict';
const fs_utils = require('./fs_utils');
const exec = require('child_process').exec;
const os = require('os');
const sysPath = require('path');
const logger = require('loggy');
const SourceNode = require('source-map').SourceNode;
const readComponents = require('read-components');
const debug = require('debug')('brunch:helpers');
const commonRequireDefinition = require('commonjs-require-definition');
const anymatch = require('anymatch');
const mediator = require('./mediator');
const coffee = require('coffee-script');

coffee.register();


/* Extends the object with properties from another object.
 * Example
 *
 *   extend {a: 5, b: 10}, {b: 15, c: 20, e: 50}
 *   # {a: 5, b: 15, c: 20, e: 50}
 */

const extend = exports.extend = function(object, properties) {
  Object.keys(properties).forEach(key => {
    return object[key] = properties[key];
  });
  return object;
};

const applyOverrides = function(config, options) {

  /* Allow the environment to be set from environment variable */
  var environments;
  config.env = options.env;
  environments = options.env;
  if (process.env.BRUNCH_ENV != null) {
    environments.unshift(process.env.BRUNCH_ENV);
  }

  /* Preserve default config before overriding */
  if (environments.length && 'overrides' in config) {
    config.overrides._default = {};
    Object.keys(config).forEach(prop => {
      var isObject;
      isObject = toString.call(config[prop]) === '[object Object]';
      if (prop === 'overrides' || !isObject) {
        return;
      }
      config.overrides._default[prop] = {};
      return deepExtend(config.overrides._default[prop], config[prop]);
    });
  }
  environments.forEach(override => {
    var k, overrideProps, ref, ref1, ref2, v;
    overrideProps = ((ref = config.overrides) != null ? ref[override] : void 0) || {};

    /* Special override handling for plugins.on|off arrays (gh-826) */
    ref1 = {
      on: 'off',
      off: 'on'
    };
    for (k in ref1) {
      v = ref1[k];
      if ((ref2 = config.plugins) != null ? ref2[v] : void 0) {
        if (overrideProps.plugins == null) {
          overrideProps.plugins = {};
        }
        overrideProps.plugins[v] = (overrideProps.plugins[v] || []).concat((config.plugins[v] || []).filter(plugin => {
          var list;
          list = overrideProps.plugins[k] || [];
          return list.indexOf(plugin) === -1;
        }));
      }
    }
    return deepExtend(config, overrideProps, config.files);
  });
  return config;
};

const deepExtend = function(object, properties, rootFiles) {
  var nestedObjs;
  if (rootFiles == null) {
    rootFiles = {};
  }
  nestedObjs = Object.keys(rootFiles).map(_ => {
    return rootFiles[_];
  });
  Object.keys(properties).forEach(key => {
    var value;
    value = properties[key];
    if (toString.call(value) === '[object Object]' && nestedObjs.indexOf(object) === -1) {
      if (object[key] == null) {
        object[key] = {};
      }
      return deepExtend(object[key], value, rootFiles);
    } else {
      return object[key] = value;
    }
  });
  return object;
};

const deepFreeze = exports.deepFreeze = object => {
  Object.keys(Object.freeze(object)).map(key => {
    return object[key];
  }).filter(value => {
    return typeof value === 'object' && (value != null) && !Object.isFrozen(value);
  }).forEach(deepFreeze);
  return object;
};

exports.formatError = function(error, path) {
  return error.code + " of '" + path + "' failed. " + (error.toString().slice(7));
};

const install = exports.install = function(rootPath, command, callback) {
  var prevDir;
  if (callback == null) {
    callback = (function() {});
  }
  prevDir = process.cwd();
  logger.info("Installing " + command + " packages...");
  process.chdir(rootPath);
  return exec(command + " install", function(error, stdout, stderr) {
    var log;
    process.chdir(prevDir);
    if (error != null) {
      log = stderr.toString();
      logger.error(log);
      return callback(log);
    }
    return callback(null, stdout);
  });
};

let isWindows = exports.isWindows = os.platform() === 'win32';

const windowsStringReplace = function(search, replacement) {
  return _ => {
    if (isWindows && typeof _ === 'string') {
      return _.replace(search, replacement);
    } else {
      return _;
    }
  };
};

const replaceSlashes = exports.replaceSlashes = windowsStringReplace(/\//g, '\\');

const replaceBackSlashes = exports.replaceBackSlashes = windowsStringReplace(/\\/g, '\/');

const replaceConfigSlashes = exports.replaceConfigSlashes = config => {
  var files;
  if (!isWindows) {
    return config;
  }
  files = config.files || {};
  Object.keys(files).forEach(language => {
    var lang, newJoinTo, order;
    lang = files[language] || {};
    order = lang.order || {};

    /* Modify order. */
    Object.keys(order).forEach(orderKey => {
      return lang.order[orderKey] = lang.order[orderKey].map(replaceSlashes);
    });

    /* Modify join configuration. */
    switch (toString.call(lang.joinTo).slice(8, -1)) {
      case 'String':
        return lang.joinTo = replaceSlashes(lang.joinTo);
      case 'Object':
        newJoinTo = {};
        Object.keys(lang.joinTo).forEach(joinToKey => {
          return newJoinTo[replaceSlashes(joinToKey)] = lang.joinTo[joinToKey];
        });
        return lang.joinTo = newJoinTo;
    }
  });
  return config;
};


/* Config items can be a RegExp or a function.
 * The function makes universal API to them.
 *
 * item - RegExp or Function
 *
 * Returns Function.
 */

const normalizeChecker = anymatch;


/* Converts `config.files[...].joinTo` to one format.
 * config.files[type].joinTo can be a string, a map of {str: regexp} or a map
 * of {str: function}.
 *
 * Example output:
 *
 * {
 *   javascripts: {'javascripts/app.js': checker},
 *   templates: {'javascripts/app.js': checker2}
 * }
 *
 * Returns Object of Object-s.
 */

const createJoinConfig = configFiles => {

  /* Can be used in `reduce` as `array.reduce(listToObj, {})`. */
  var joinConfig, listToObj, types;
  listToObj = function(acc, elem) {
    acc[elem[0]] = elem[1];
    return acc;
  };
  types = Object.keys(configFiles);
  joinConfig = types.map(type => {
    return configFiles[type].joinTo;
  }).map(joinTo => {
    var object;
    if (typeof joinTo === 'string') {
      object = {};
      object[joinTo] = /.+/;
      return object;
    } else {
      return joinTo;
    }
  }).map(function(joinTo, index) {
    var makeChecker, subConfig;
    makeChecker = generatedFilePath => {
      return [generatedFilePath, normalizeChecker(joinTo[generatedFilePath])];
    };
    subConfig = Object.keys(joinTo).map(makeChecker).reduce(listToObj, {});
    return [types[index], subConfig];
  }).reduce(listToObj, {});

  /* special matching for plugin helpers */
  types.forEach(type => {
    var pluginHelpers;
    pluginHelpers = configFiles[type].pluginHelpers;
    return joinConfig[type].pluginHelpers = Array.isArray(pluginHelpers) ? pluginHelpers : pluginHelpers ? [pluginHelpers] : (function() {
      var destFiles, joinMatch, nameMatch;
      destFiles = Object.keys(joinConfig[type]);
      joinMatch = destFiles.filter(file => {
        return joinConfig[type][file]('vendor/.');
      });
      if (joinMatch.length > 0) {
        return [joinMatch[0]];
      }
      nameMatch = destFiles.filter(file => {
        return /vendor/i.test(file);
      });
      if (nameMatch.length > 0) {
        return [nameMatch[0]];
      }
      return [destFiles.shift()];
    })();
  });
  return Object.freeze(joinConfig);
};

const identityNode = exports.identityNode = function(code, source) {
  return new SourceNode(1, 0, null, code.split('\n').map(function(line, index) {
    return new SourceNode(index + 1, 0, source, line + '\n');
  }));
};

const cleanModuleName = exports.cleanModuleName = function(path, nameCleaner) {
  return nameCleaner(path.replace(new RegExp('\\\\', 'g'), '/').replace(new RegExp('^(\.\.\/)*', 'g'), ''));
};

const getModuleWrapper = function(type, nameCleaner) {
  return function(fullPath, data, isVendor) {
    var moduleName, path, sourceURLPath;
    sourceURLPath = cleanModuleName(fullPath, nameCleaner);
    moduleName = sourceURLPath.replace(/\.\w+$/, '');
    path = JSON.stringify(moduleName);
    if (isVendor) {
      debug("Not wrapping '" + path + "', is vendor file");
      return data;
    } else {
      debug("Wrapping '" + path + "' with " + type);

      /* Wrap in common.js require definition. */
      if (type === 'commonjs') {
        return {
          prefix: "require.register(" + path + ", function(exports, require, module) {\n",
          suffix: "});\n\n"
        };
      } else if (type === 'amd') {
        return {
          data: data.replace(/define\s*\(/, match => {
            return "" + match + path + ", ";
          })
        };
      }
    }
  };
};

const normalizeWrapper = function(typeOrFunction, nameCleaner) {
  switch (typeOrFunction) {
    case 'commonjs':
      return getModuleWrapper('commonjs', nameCleaner);
    case 'amd':
      return getModuleWrapper('amd', nameCleaner);
    case false:
      return function(path, data) {
        return data;
      };
    default:
      if (typeof typeOrFunction === 'function') {
        return typeOrFunction;
      } else {
        throw new Error('config.modules.wrapper should be a function or one of: "commonjs", "amd", false');
      }
  }
};

const normalizeDefinition = typeOrFunction => {
  switch (typeOrFunction) {
    case 'commonjs':
      return function() {
        return commonRequireDefinition;
      };
    case 'amd':
    case false:
      return function() {
        return '';
      };
    default:
      if (typeof typeOrFunction === 'function') {
        return typeOrFunction;
      } else {
        throw new Error('config.modules.definition should be a function or one of: "commonjs", false');
      }
  }
};

const setConfigDefaults = exports.setConfigDefaults = function(config, configPath) {
  var base, base1, conventions, join, joinRoot, modules, npm, overrides, paths, production, server;
  join = function(parent, name) {
    return sysPath.join(config.paths[parent], name);
  };
  joinRoot = name => {
    return join('root', name);
  };
  paths = config.paths != null ? config.paths : config.paths = {};
  if (paths.root == null) {
    paths.root = '.';
  }
  if (paths["public"] == null) {
    paths["public"] = joinRoot('public');
  }
  if (paths.watched == null) {
    paths.watched = ['app', 'test', 'vendor'].map(joinRoot);
  }
  if (paths.config == null) {
    paths.config = configPath != null ? configPath : joinRoot('config');
  }
  if (paths.packageConfig == null) {
    paths.packageConfig = joinRoot('package.json');
  }
  if (paths.bowerConfig == null) {
    paths.bowerConfig = joinRoot('bower.json');
  }
  conventions = config.conventions != null ? config.conventions : config.conventions = {};
  if (conventions.assets == null) {
    conventions.assets = /assets[\\\/]/;
  }
  if (conventions.ignored == null) {
    conventions.ignored = paths.ignored || [/[\\\/]_/, /vendor[\\\/](node|j?ruby-.*|bundle)[\\\/]/];
  }
  if (conventions.vendor == null) {
    conventions.vendor = /(^bower_components|node_modules|vendor)[\\\/]/;
  }
  if (config.notifications == null) {
    config.notifications = true;
  }
  if (config.sourceMaps == null) {
    config.sourceMaps = true;
  }
  if (config.optimize == null) {
    config.optimize = false;
  }
  if (config.plugins == null) {
    config.plugins = {};
  }
  modules = config.modules != null ? config.modules : config.modules = {};
  if (modules.wrapper == null) {
    modules.wrapper = 'commonjs';
  }
  if (modules.definition == null) {
    modules.definition = 'commonjs';
  }
  if (modules.nameCleaner == null) {
    modules.nameCleaner = path => {
      return path.replace(/^app\//, '');
    };
  }
  if (modules.autoRequire == null) {
    modules.autoRequire = {};
  }
  server = config.server != null ? config.server : config.server = {};
  if (server.base == null) {
    server.base = '';
  }
  if (server.port == null) {
    server.port = 3333;
  }
  if (server.run == null) {
    server.run = false;
  }
  overrides = config.overrides != null ? config.overrides : config.overrides = {};
  production = overrides.production != null ? overrides.production : overrides.production = {};
  if (production.optimize == null) {
    production.optimize = true;
  }
  if (production.sourceMaps == null) {
    production.sourceMaps = false;
  }
  if (production.plugins == null) {
    production.plugins = {};
  }
  if ((base = production.plugins).autoReload == null) {
    base.autoReload = {};
  }
  if ((base1 = production.plugins.autoReload).enabled == null) {
    base1.enabled = false;
  }
  npm = config.npm != null ? config.npm : config.npm = {};
  if (npm.enabled == null) {
    npm.enabled = false;
  }
  return config;
};

const warnAboutConfigDeprecations = config => {
  var ensureNotArray, messages, warnMoved, warnRemoved;
  messages = [];
  warnRemoved = path => {
    if (config.paths[path]) {
      return messages.push("config.paths." + path + " was removed, use config.paths.watched");
    }
  };
  warnMoved = function(configItem, from, to) {
    if (configItem) {
      return messages.push("config." + from + " moved to config." + to);
    }
  };
  warnRemoved('app');
  warnRemoved('test');
  warnRemoved('vendor');
  warnRemoved('assets');
  warnMoved(config.paths.ignored, 'paths.ignored', 'conventions.ignored');
  warnMoved(config.rootPath, 'rootPath', 'paths.root');
  warnMoved(config.buildPath, 'buildPath', 'paths.public');
  ensureNotArray = name => {
    if (Array.isArray(config.paths[name])) {
      return messages.push("config.paths." + name + " can't be an array. Use config.conventions." + name);
    }
  };
  ensureNotArray('assets');
  ensureNotArray('test');
  ensureNotArray('vendor');
  messages.forEach(logger.warn);
  return config;
};

const normalizeConfig = config => {
  var mod, normalized;
  normalized = {};
  normalized.join = createJoinConfig(config.files);
  mod = config.modules;
  normalized.modules = {};
  normalized.modules.wrapper = normalizeWrapper(mod.wrapper, config.modules.nameCleaner);
  normalized.modules.definition = normalizeDefinition(mod.definition);
  normalized.modules.autoRequire = mod.autoRequire;
  normalized.conventions = {};
  Object.keys(config.conventions).forEach(name => {
    return normalized.conventions[name] = normalizeChecker(config.conventions[name]);
  });
  normalized.paths = {};
  normalized.paths.possibleConfigFiles = Object.keys(require.extensions).map(_ => {
    return config.paths.config + _;
  }).reduce(function(obj, _) {
    obj[_] = true;
    return obj;
  }, {});
  normalized.paths.allConfigFiles = [config.paths.packageConfig, config.paths.bowerConfig].concat(Object.keys(normalized.paths.possibleConfigFiles));
  normalized.packageInfo = {};
  config._normalized = normalized;
  ['on', 'off', 'only'].forEach(key => {
    if (typeof config.plugins[key] === 'string') {
      return config.plugins[key] = [config.plugins[key]];
    }
  });
  return config;
};

const addDefaultServer = config => {
  var base, defaultServerPath, e, error1, resolved;
  if (config.server.path) {
    return config;
  }
  defaultServerPath = 'brunch-server';
  try {
    resolved = require.resolve(sysPath.resolve(defaultServerPath));
    require(resolved);
    if ((base = config.server).path == null) {
      base.path = resolved;
    }
  } catch (error1) {
    e = error1;

    /* Do nothing. */
  }
  return config;
};

const loadComponents = function(config, type, callback) {
  return readComponents('.', type, function(error, components, aliases) {
    var order;
    if (error && !/ENOENT/.test(error.toString())) {
      logger.error(error);
    }
    if (components == null) {
      components = [];
    }
    order = components.sort(function(a, b) {
      if (a.sortingLevel === b.sortingLevel) {
        if (a.files[0] < b.files[0]) {
          return -1;
        } else {
          return 1;
        }
      } else {
        return b.sortingLevel - a.sortingLevel;
      }
    }).reduce(function(flat, component) {
      return flat.concat(component.files);
    }, []);
    return callback({
      components: components,
      aliases: aliases,
      order: order
    });
  });
};

const loadNpm = function(config, cb) {
  var error, error1, items, json, jsonPath, paths, rootPath;
  if (!config.npm.enabled) {
    return cb({
      components: []
    });
  }
  mediator.npmIsEnabled = true;
  paths = config.paths;
  rootPath = sysPath.resolve(paths.root);
  jsonPath = sysPath.join(rootPath, paths.packageConfig);
  try {
    json = require(jsonPath);
  } catch (error1) {
    error = error1;
    throw new Error("You probably need to execute `npm install` to install brunch plugins. " + error);
  }
  items = Object.keys(json.dependencies || {}).filter(dep => {

    /* Ignore Brunch plugins. */
    return dep !== 'brunch' && dep.indexOf('brunch') === -1 && !normalizeChecker(config.conventions.ignored, dep);
  }).map(dep => {
    var depJson, depMain, depPath, file, ref;
    depPath = sysPath.join(rootPath, 'node_modules', dep);
    depJson = require(sysPath.join(depPath, 'package.json'));
    if ((ref = json.overrides) != null ? ref[dep] : void 0) {
      depJson = deepExtend(depJson, json.overrides[dep]);
    }
    depMain = depJson.main || 'index.js';
    file = sysPath.join('node_modules', dep, depMain);
    return {
      name: dep,
      files: [file],
      version: json.dependencies[dep]
    };
  });
  return cb({
    components: items
  });
};

const addPackageManagers = function(config, callback) {
  return loadNpm(config, npmRes => {
    config._normalized.packageInfo.npm = npmRes;
    return loadComponents(config, 'bower', bowerRes => {
      config._normalized.packageInfo.bower = bowerRes;
      return loadComponents(config, 'component', componentRes => {
        config._normalized.packageInfo.component = componentRes;
        return callback();
      });
    });
  });
};

exports.loadConfig = function(configPath, options, callback) {
  var config, error, error1, fullPath, obj;
  if (configPath == null) {
    configPath = 'brunch-config';
  }
  if (options == null) {
    options = {};
  }
  try {

    /* Assign fullPath in two steps in case require.resolve throws. */
    fullPath = sysPath.resolve(configPath);
    fullPath = require.resolve(fullPath);
    delete require.cache[fullPath];
    obj = require(fullPath);
    config = obj.config || obj;
    if (!config) {
      throw new Error('Brunch config must be a valid object');
    }
    if (!config.files) {
      throw new Error('Brunch config must have "files" property');
    }
  } catch (error1) {
    error = error1;
    if (configPath === 'brunch-config' && error.code === 'MODULE_NOT_FOUND') {

      /* start to warn about deprecation of 'config' with 1.8 release
       * seamless and silent fallback until then
       */
      return exports.loadConfig('config', options, callback);

      /* 'config' should remain available as a working deprecated option until 2.0 */
    } else {
      throw new Error("couldn\'t load config " + fullPath + ". " + error);
    }
  }
  setConfigDefaults(config, configPath);
  addDefaultServer(config);
  warnAboutConfigDeprecations(config);
  applyOverrides(config, options);
  deepExtend(config, options);
  replaceConfigSlashes(config);
  normalizeConfig(config);
  return addPackageManagers(config, function() {
    deepFreeze(config);
    return callback(null, config);
  });
};