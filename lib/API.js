/**
 * Copyright 2013 the PM2 project authors. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

var commander = require('commander');
var fs = require('fs');
var path = require('path');
var async = require('async');
var debug = require('debug')('pm2:cli');
var util = require('util');
var chalk = require('chalk');
var fclone = require('fclone');
var moment = require('moment');

var conf = require('../constants.js');
var Client = require('./Client');
var Common = require('./Common');
var KMDaemon = require('./Interactor/InteractorDaemonizer');
var Config = require('./tools/Config');
var Modularizer = require('./API/Modules/Modularizer.js');
var pathStructure = require('../paths.js');
var UX = require('./API/CliUx');

var IMMUTABLE_MSG = chalk.bold.blue('Use --update-env to update environment variables');

/**
 * Main Function to be imported
 * can be aliased to PM2
 *
 * To use it when PM2 is installed as a module:
 *
 * var PM2 = require('pm2');
 *
 * var pm2 = PM2(<opts>);
 *
 *
 * @param {Object}  opts
 * @param {String}  [opts.cwd=<current>]         override pm2 cwd for starting scripts
 * @param {String}  [opts.pm2_home=[<paths.js>]] pm2 directory for log, pids, socket files
 * @param {Boolean} [opts.independent=false]     unique PM2 instance (random pm2_home)
 * @param {Boolean} [opts.daemon_mode=true]      should be called in the same process or not
 * @param {String}  [opts.public_key=null]       keymetrics bucket public key
 * @param {String}  [opts.secret_key=null]       keymetrics bucket secret key
 * @param {String}  [opts.machine_name=null]     keymetrics instance name
 */
var API = module.exports = function (opts) {
  if (!opts) opts = {};
  var that = this;

  this.daemon_mode = typeof (opts.daemon_mode) === 'undefined' ? true : opts.daemon_mode;
  this.pm2_home = conf.PM2_ROOT_PATH;
  this.public_key = process.env.KEYMETRICS_SECRET || opts.public_key || null;
  this.secret_key = process.env.KEYMETRICS_PUBLIC || opts.secret_key || null;
  this.machine_name = process.env.INSTANCE_NAME || opts.machine_name || null;

  /**
   * CWD resolution
   */
  this.cwd = process.cwd();
  if (opts.cwd) {
    this.cwd = path.resolve(opts.cwd);
  }

  /**
   * PM2 HOME resolution
   */
  if (opts.pm2_home && opts.independent === true) {
    throw new Error('You cannot set a pm2_home and independent instance in same time');
  }

  if (opts.pm2_home) {
    // Override default conf file
    this.pm2_home = opts.pm2_home;
    conf = util._extend(conf, pathStructure(this.pm2_home));
  } else if (opts.independent === true && conf.IS_WINDOWS === false) {
    // Create an unique pm2 instance
    var crypto = require('crypto');
    var randomName = crypto.randomBytes(8).toString('hex');
    this.pm2_home = path.join('/tmp', randomName);

    // If we dont explicitly tell to have a daemon
    // It will go as in proc
    if (typeof (opts.daemon_mode) === 'undefined') {
      this.daemon_mode = false;
    }
    conf = util._extend(conf, pathStructure(this.pm2_home));
  }

  this._conf = conf;

  if (conf.IS_WINDOWS) {
    // Weird fix, may need to be dropped
    // @todo windows connoisseur double check
    if (process.stdout._handle && process.stdout._handle.setBlocking) {
      process.stdout._handle.setBlocking(true);
    }
  }

  this.Client = new Client({
    pm2_home: that.pm2_home,
    conf: this._conf,
    secret_key: this.secret_key,
    public_key: this.public_key,
    daemon_mode: this.daemon_mode,
    machine_name: this.machine_name
  });

  this.gl_interact_infos = null;
  this.gl_is_km_linked = false;

  try {
    var pid = fs.readFileSync(conf.INTERACTOR_PID_PATH);
    pid = parseInt(pid.toString().trim());
    process.kill(pid, 0);
    that.gl_is_km_linked = true;
  } catch (e) {
    that.gl_is_km_linked = false;
  }

  // For testing purposes
  if (this.secret_key && process.env.NODE_ENV === 'local_test') {
    that.gl_is_km_linked = true;
  }

  KMDaemon.getInteractInfo(this._conf, function (ignoredErr, interact) {
    that.gl_interact_infos = interact;
  });
};

/**
 * Connect to PM2
 * Calling this command is now optionnal
 *
 * @param {Function} cb callback once pm2 is ready for commands
 */
API.prototype.connect = function (noDaemon, cb) {
  var that = this;
  this.start_timer = new Date();

  if (typeof (cb) === 'undefined') {
    cb = noDaemon;
    noDaemon = false;
  } else if (noDaemon === true) {
    // Backward compatibility with PM2 1.x
    this.Client.daemon_mode = false;
    this.daemon_mode = false;
  }

  this.Client.start(function (err, meta) {
    if (err) {
      return cb(err);
    }

    if (meta.new_pm2_instance === false && that.daemon_mode === true) {
      return cb(err, meta);
    }

    // If new pm2 instance has been popped
    // Lauch all modules
    Modularizer.launchAll(that, function (ignoredErr) {
      return cb(err, meta);
    });
  });
};

/**
 * Usefull when custom PM2 created with independent flag set to true
 * This will cleanup the newly created instance
 * by removing folder, killing PM2 and so on
 *
 * @param {Function} cb callback once cleanup is successfull
 */
API.prototype.destroy = function (cb) {
  var exec = require('shelljs').exec;
  var that = this;

  debug('Killing and deleting current deamon');

  this.killDaemon(function () {
    var cmd = 'rm -rf ' + that.pm2_home;
    var tmpPath = path.join(that.pm2_home, 'module_conf.json');

    if (that.pm2_home.indexOf('.pm2') > -1) {
      return cb(new Error('Destroy is not a allowed method on .pm2'));
    }

    if (fs.accessSync) {
      fs.access(tmpPath, fs.R_OK, function (err) {
        if (err) return cb(err);
        debug('Deleting temporary folder %s', that.pm2_home);
        exec(cmd, cb);
      });
      return false;
    } else {
       // Support for Node 0.10
      fs.exists(tmpPath, function (exist) {
        if (exist) {
          debug('Deleting temporary folder %s', that.pm2_home);
          exec(cmd, cb);
        }
        return cb(null);
      });
    }
  });
};

/**
 * Disconnect from PM2 instance
 * This will allow your software to exit by itself
 *
 * @param {Function} [cb] optionnal callback once connection closed
 */
API.prototype.disconnect = API.prototype.close = function (cb) {
  var that = this;

  if (!cb) cb = function () {};

  this.Client.close(function (err, data) {
    debug('The session lasted %ds', (new Date() - that.start_timer) / 1000);
    return cb(err, data);
  });
};

/**
 * Launch modules
 *
 * @param {Function} cb callback once pm2 has launched modules
 */
API.prototype.launchModules = function (cb) {
  Modularizer.launchAll(this, cb);
};

/**
 * Enable bus allowing to retrieve various process event
 * like logs, restarts, reloads
 *
 * @param {Function} cb callback called with 1st param err and 2nb param the bus
 */
API.prototype.launchBus = function (cb) {
  this.Client.launchBus(cb);
};

/**
 * Exit methods for API
 * @param {Integer} code exit code for terminal
 */
API.prototype.exitCli = function (code) {
  var that = this;

  // Do nothing if PM2 called programmatically (also in speedlist)
  if (conf.PM2_PROGRAMMATIC && process.env.PM2_USAGE !== 'CLI') return false;

  KMDaemon.disconnectRPC(function () {
    that.Client.close(function () {
      code = code || 0;
      // Safe exits process after all streams are drained.
      // file descriptor flag.
      var fds = 0;
      // exits process when stdout (1) and sdterr(2) are both drained.
      function tryToExit () {
        if ((fds & 1) && (fds & 2)) {
          debug('This command took %ds to execute', (new Date() - that.start_timer) / 1000);
          process.exit(code);
        }
      }

      [process.stdout, process.stderr].forEach(function (std) {
        var fd = std.fd;
        if (!std.bufferSize) {
          // bufferSize equals 0 means current stream is drained.
          fds = fds | fd;
        } else {
          // Appends nothing to the std queue, but will trigger `tryToExit` event on `drain`.
          std.write && std.write('', function () {
            fds = fds | fd;
            tryToExit();
          });
        }
        // Does not write anything more.
        delete std.write;
      });
      tryToExit();
    });
  });
};

// ////////////////////////
// Load all API methods //
// ////////////////////////

require('./API/Deploy.js')(API);
require('./API/Modules/Modules.js')(API);
require('./API/Configuration.js')(API);
require('./API/Extra.js')(API);
require('./API/Version.js')(API);
require('./API/Startup.js')(API);
require('./API/LogManagement.js')(API);
require('./API/Interaction.js')(API);
require('./API/Containerizer.js')(API);

// //////////////////////////
// Application management //
// //////////////////////////

/**
 * Start a file or json with configuration
 * @param {Object||String} cmd script to start or json
 * @param {Function} cb called when application has been started
 */
API.prototype.start = function (cmd, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  if (!opts) {
    opts = {};
  }

  var that = this;

  if (util.isArray(opts.watch) && opts.watch.length === 0) {
    opts.watch = (opts.rawArgs ? !!~opts.rawArgs.indexOf('--watch') : !!~process.argv.indexOf('--watch')) || false;
  }

  if (Common.isConfigFile(cmd) || (typeof cmd === 'object')) {
    that._startJson(cmd, opts, 'restartProcessId', cb);
  } else {
    that._startScript(cmd, opts, cb);
  }
};

/**
 * Reset process counters
 *
 * @method resetMetaProcess
 */
API.prototype.reset = function (processName, cb) {
  var that = this;

  function processIds (ids, cb) {
    async.eachLimit(ids, conf.CONCURRENT_ACTIONS, function (id, next) {
      that.Client.executeRemote('resetMetaProcessId', id, function (err, res) {
        if (err) console.error(err);
        Common.printOut(conf.PREFIX_MSG + 'Resetting meta for process id %d', id);
        return next();
      });
    }, function (err) {
      if (err) return cb(Common.retErr(err));
      return cb ? cb(null, { success: true }) : that.speedList();
    });
  }

  if (processName === 'all') {
    that.Client.getAllProcessId(function (err, ids) {
      if (err) {
        Common.printError(err);
        return cb ? cb(Common.retErr(err)) : that.exitCli(conf.ERROR_EXIT);
      }
      return processIds(ids, cb);
    });
  } else if (isNaN(processName)) {
    that.Client.getProcessIdByName(processName, function (err, ids) {
      if (err) {
        Common.printError(err);
        return cb ? cb(Common.retErr(err)) : that.exitCli(conf.ERROR_EXIT);
      }
      if (ids.length === 0) {
        Common.printError('Unknown process name');
        return cb ? cb(new Error('Unknown process name')) : that.exitCli(conf.ERROR_EXIT);
      }
      return processIds(ids, cb);
    });
  } else {
    processIds([processName], cb);
  }
};

/**
 * Update daemonized PM2 Daemon
 *
 * @param {Function} cb callback when pm2 has been upgraded
 */
API.prototype.update = function (cb) {
  var that = this;

  Common.printOut('Be sure to have the latest version by doing `npm install pm2@latest -g` before doing this procedure.');

  // Dump PM2 processes
  that.Client.executeRemote('notifyKillPM2', {}, function () {});

  that.dump(function (err) {
    debug('Dumping successfull', err);
    that.killDaemon(function () {
      debug('------------------ Everything killed', arguments);
      that.Client.launchDaemon({ interactor: false }, function (err, child) {
        if (err) {
          return typeof cb === 'function' ? cb(err) : that.exitCli(conf.ERROR_EXIT);
        }
        that.Client.launchRPC(function () {
          that.resurrect(function () {
            Common.printOut(chalk.blue.bold('>>>>>>>>>> PM2 updated'));
            Modularizer.launchAll(that, function () {
              KMDaemon.launchAndInteract(that._conf, {}, function (ignoredErr, data, interactorProc) {
                // Interactor error can be skipped here
                return cb ? cb(null, { success: true }) : that.speedList();
              });
            });
          });
        });
      });
    });
  });

  return false;
};

/**
 * Graceful Reload an application
 *
 * @param {String} process_name Application Name or All
 * @param {Object} opts         Options
 * @param {Function} cb         Callback
 */
API.prototype.gracefulReload = function (processName, opts, cb) {
  var that = this;

  if (typeof (opts) === 'function') {
    cb = opts;
    opts = {};
  }

  if (Common.isConfigFile(processName)) {
    that._startJson(processName, commander, 'softReloadProcessId');
  } else {
    if (opts && !opts.updateEnv) { Common.printOut(IMMUTABLE_MSG); }
    that._operate('softReloadProcessId', processName, opts, cb);
  }
};

/**
 * Reload an application
 *
 * @param {String} process_name Application Name or All
 * @param {Object} opts         Options
 * @param {Function} cb         Callback
 */
API.prototype.reload = function (processName, opts, cb) {
  var that = this;

  if (typeof (opts) === 'function') {
    cb = opts;
    opts = {};
  }

  if (Common.isConfigFile(processName)) {
    that._startJson(processName, opts, 'reloadProcessId');
  } else {
    if (opts && !opts.updateEnv) {
      Common.printOut(IMMUTABLE_MSG);
    }
    that._operate('reloadProcessId', processName, opts, cb);
  }
};

/**
 * Restart process
 *
 * @param {String} cmd   Application Name / Process id / JSON application file / 'all'
 * @param {Object} opts  Extra options to be updated
 * @param {Function} cb  Callback
 */
API.prototype.restart = function (cmd, opts, cb) {
  if (typeof (opts) === 'function') {
    cb = opts;
    opts = {};
  }
  var that = this;

  if (typeof (cmd) === 'number') {
    cmd = cmd.toString();
  }

  if (cmd === '-') {
    // Restart from PIPED JSON
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (param) {
      process.stdin.pause();
      that.actionFromJson('restartProcessId', param, opts, 'pipe', cb);
    });
  } else if (Common.isConfigFile(cmd) || typeof (cmd) === 'object') {
    that._startJson(cmd, opts, 'restartProcessId', cb);
  } else {
    if (opts && !opts.updateEnv) {
      Common.printOut(IMMUTABLE_MSG);
    }
    that._operate('restartProcessId', cmd, opts, cb);
  }
};

/**
 * Delete process
 *
 * @param {String} process_name Application Name / Process id / Application file / 'all'
 * @param {Function} cb Callback
 */
API.prototype.delete = function (processName, jsonVia, cb) {
  var that = this;

  if (typeof (jsonVia) === 'function') {
    cb = jsonVia;
    jsonVia = null;
  }
  if (typeof (processName) === 'number') {
    processName = processName.toString();
  }
  if (jsonVia === 'pipe') {
    return that.actionFromJson('deleteProcessId', processName, commander, 'pipe', cb);
  }
  if (Common.isConfigFile(processName)) {
    return that.actionFromJson('deleteProcessId', processName, commander, 'file', cb);
  } else {
    that._operate('deleteProcessId', processName, cb);
  }
};

/**
 * Stop process
 *
 * @param {String} process_name Application Name / Process id / Application file / 'all'
 * @param {Function} cb Callback
 */
API.prototype.stop = function (processName, cb) {
  var that = this;

  if (typeof (processName) === 'number') {
    processName = processName.toString();
  }

  if (processName === '-') {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (param) {
      process.stdin.pause();
      that.actionFromJson('stopProcessId', param, commander, 'pipe', cb);
    });
  } else if (Common.isConfigFile(processName)) {
    that.actionFromJson('stopProcessId', processName, commander, 'file', cb);
  } else { that._operate('stopProcessId', processName, cb); }
};

/**
 * Get list of all processes managed
 *
 * @param {Function} cb Callback
 */
API.prototype.list = function (opts, cb) {
  var that = this;

  if (typeof (opts) === 'function') {
    cb = opts;
    opts = null;
  }

  function show () {
    process.stdout.write('\x1B[2J');
    process.stdout.write('\x1B[0f');
    console.log('Last refresh: ', moment().format('LTS'));
    that.Client.executeRemote('getMonitorData', {}, function (ignoredErr, list) {
      UX.dispAsTable(list, null);
    });
  }

  that.Client.executeRemote('getMonitorData', {}, function (err, list) {
    if (err) {
      Common.printError(err);
      return cb ? cb(Common.retErr(err)) : that.exitCli(conf.ERROR_EXIT);
    }

    if (opts && opts.rawArgs && opts.rawArgs.indexOf('--watch') > -1) {
      show();
      setInterval(show, 900);
      return false;
    }

    return cb ? cb(null, list) : that.speedList();
  });
};

/**
 * Kill Daemon
 *
 * @param {Function} cb Callback
 */
API.prototype.killDaemon = API.prototype.kill = function (cb) {
  var that = this;

  var semver = require('semver');
  Common.printOut(conf.PREFIX_MSG + 'Stopping PM2...');

  that.Client.executeRemote('notifyKillPM2', {}, function () {});

  that.getVersion(function (err, data) {
    if (!err && semver.lt(data, '1.1.0')) {
      // Disable action command output if upgrading from < 1.1.0 PM2
      // This is in order to avoid duplicated output
      process.env.PM2_SILENT = 'true';
      console.log(conf.PREFIX_MSG + 'Killing processes...');
    }

    that.killAllModules(function () {
      that._operate('deleteProcessId', 'all', function (ignoredErr, list) {
        Common.printOut(conf.PREFIX_MSG + 'All processes have been stopped and deleted');
        process.env.PM2_SILENT = 'false';

        that.killInteract(function (ignoredErr, data) {
          that.Client.killDaemon(function (err, res) {
            if (err) Common.printError(err);
            Common.printOut(conf.PREFIX_MSG + 'PM2 stopped');
            return cb ? cb(err, res) : that.exitCli(conf.SUCCESS_EXIT);
          });
        });
      });
    });
  });
};

// ///////////////////
// Private methods //
// ///////////////////

/**
 * Method to START / RESTART a script
 *
 * @private
 * @param {string} script script name (will be resolved according to location)
 */
API.prototype._startScript = function (script, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  var that = this;

  var tmpConf = Config.transCMDToConf(opts);
  var finalConf = {};

  if (opts.executeCommand) {
    tmpConf.exec_mode = 'fork';
  } else if (opts.instances !== undefined) {
    tmpConf.exec_mode = 'cluster';
  } else {
    tmpConf.exec_mode = 'fork';
  }

  if (typeof tmpConf.name === 'function') {
    delete tmpConf.name;
  }

  delete tmpConf.args;

  var argsIndex;

  if (opts.rawArgs && (argsIndex = opts.rawArgs.indexOf('--')) >= 0) {
    tmpConf.args = opts.rawArgs.slice(argsIndex + 1);
  } else if (opts.scriptArgs) {
    tmpConf.args = opts.scriptArgs;
  }

  tmpConf.script = script;

  if ((finalConf = Common.verifyConfs(tmpConf)) instanceof Error) {
    return cb ? cb(Common.retErr(finalConf)) : that.exitCli(conf.ERROR_EXIT);
  }

  tmpConf = finalConf[0];

  /**
   * If -w option, write configuration to configuration.json file
   */
  if (finalConf.write) {
    var dstPath = path.join(process.env.PWD || process.cwd(), tmpConf.name + '-pm2.json');
    Common.printOut(conf.PREFIX_MSG + 'Writing configuration to', chalk.blue(dstPath));
    // pretty JSON
    try {
      fs.writeFileSync(dstPath, JSON.stringify(tmpConf, null, 2));
    } catch (e) {
      console.error(e.stack || e);
    }
  }

  /**
   * If start <app_name> start/restart application
   */
  function restartExistingProcessName (cb) {
    if (!isNaN(script) ||
        (typeof script === 'string' && script.indexOf('/') !== -1) ||
        (typeof script === 'string' && path.extname(script) !== '')) {
      return cb(null);
    }

    if (script !== 'all') {
      that.Client.getProcessIdByName(script, function (err, ids) {
        if (err && cb) return cb(err);
        if (ids.length > 0) {
          that._operate('restartProcessId', script, opts, function (err, list) {
            if (err) return cb(err);
            Common.printOut(conf.PREFIX_MSG + 'Process successfully started');
            return cb(true, list);
          });
        } else return cb(null);
      });
    } else {
      that._operate('restartProcessId', 'all', function (err, list) {
        if (err) return cb(err);
        Common.printOut(conf.PREFIX_MSG + 'Process successfully started');
        return cb(true, list);
      });
    }
  }

  function restartExistingProcessId (cb) {
    if (isNaN(script)) return cb(null);

    that._operate('restartProcessId', script, opts, function (err, list) {
      if (err) return cb(err);
      Common.printOut(conf.PREFIX_MSG + 'Process successfully started');
      return cb(true, list);
    });
  }

  /**
   * Restart a process with the same full path
   * Or start it
   */
  function restartExistingProcessPath (cb) {
    that.Client.executeRemote('getMonitorData', {}, function (err, procs) {
      if (err) return cb ? cb(new Error(err)) : that.exitCli(conf.ERROR_EXIT);

      var fullPath = path.resolve(that.cwd, script);
      var managedScript = null;

      procs.forEach(function (proc) {
        if (proc.pm2_env.pm_exec_path === fullPath &&
            proc.pm2_env.name === conf.name) {
          managedScript = proc;
        }
      });

      if (managedScript &&
          (managedScript.pm2_env.status === conf.STOPPED_STATUS ||
           managedScript.pm2_env.status === conf.STOPPING_STATUS ||
           managedScript.pm2_env.status === conf.ERRORED_STATUS)) {
        // Restart process if stopped
        var appName = managedScript.pm2_env.name;

        that._operate('restartProcessId', appName, opts, function (err, list) {
          if (err) return cb ? cb(new Error(err)) : that.exitCli(conf.ERROR_EXIT);
          Common.printOut(conf.PREFIX_MSG + 'Process successfully started');
          return cb(true, list);
        });
        return false;
      } else if (managedScript && !opts.force) {
        Common.printError(conf.PREFIX_MSG_ERR + 'Script already launched, add -f option to force re-execution');
        return cb(new Error('Script already launched'));
      }

      var resolvedPaths = null;

      try {
        resolvedPaths = Common.resolveAppAttributes({
          cwd: that.cwd,
          pm2_home: that.pm2_home
        }, tmpConf);
      } catch (e) {
        Common.printError(e);
        return cb(Common.retErr(e));
      }

      Common.printOut(conf.PREFIX_MSG + 'Starting %s in %s (%d instance' + (resolvedPaths.instances > 1 ? 's' : '') + ')',
                      resolvedPaths.pm_exec_path, resolvedPaths.exec_mode, resolvedPaths.instances);

      if (!resolvedPaths.env) resolvedPaths.env = {};

      // Set PM2 HOME in case of child process using PM2 API
      resolvedPaths.env['PM2_HOME'] = that.pm2_home;

      var additionalEnv = Modularizer.getAdditionalConf(resolvedPaths.name);
      util._extend(resolvedPaths.env, additionalEnv);

      // Is KM linked?
      resolvedPaths.km_link = that.gl_is_km_linked;

      that.Client.executeRemote('prepare', resolvedPaths, function (err, data) {
        if (err) {
          Common.printError(conf.PREFIX_MSG_ERR + 'Error while launching application', err.stack || err);
          return cb(Common.retErr(err));
        }

        Common.printOut(conf.PREFIX_MSG + 'Done.');
        return cb(true, data);
      });
      return false;
    });
  }

  async.series([
    restartExistingProcessName,
    restartExistingProcessId,
    restartExistingProcessPath
  ], function (err, data) {
    if (err instanceof Error) {
      return cb ? cb(err) : that.exitCli(conf.ERROR_EXIT);
    }

    var ret = {};
    data.forEach(function (_dt) {
      if (_dt !== undefined) {
        ret = _dt;
      }
    });

    return cb ? cb(null, ret) : that.speedList();
  });
};

/**
 * Method to start/restart/reload processes from a JSON file
 * It will start app not started
 * Can receive only option to skip applications
 *
 * @private
 */
API.prototype._startJson = function (file, opts, action, pipe, cb) {
  var config = {};
  var appConf = {};
  var deployConf = {};
  var appsInfo = [];
  var that = this;

  if (typeof (cb) === 'undefined' && typeof (pipe) === 'function') {
    cb = pipe;
  }

  if (typeof (file) === 'object') {
    config = file;
  } else if (pipe === 'pipe') {
    config = Common.parseConfig(file, 'pipe');
  } else {
    var data = null;

    var filePath = path.join(that.cwd, file);

    if (file[0] === '/') {
      filePath = file;
    }

    debug('Resolved filepath %s', filePath);

    try {
      data = fs.readFileSync(filePath);
    } catch (e) {
      Common.printError(conf.PREFIX_MSG_ERR + 'File ' + file + ' not found');
      return cb ? cb(Common.retErr(e)) : that.exitCli(conf.ERROR_EXIT);
    }

    try {
      config = Common.parseConfig(data, file);
    } catch (e) {
      Common.printError(conf.PREFIX_MSG_ERR + 'File ' + file + ' malformated');
      console.error(e);
      return cb ? cb(Common.retErr(e)) : that.exitCli(conf.ERROR_EXIT);
    }
  }

  if (config.deploy) {
    deployConf = config.deploy;
  }

  if (config.apps) {
    appConf = config.apps;
  } else {
    appConf = config;
  }

  if (!Array.isArray(appConf)) {
    appConf = [appConf];
  } // convert to array

  if ((appConf = Common.verifyConfs(appConf)) instanceof Error) { return cb ? cb(appConf) : that.exitCli(conf.ERROR_EXIT); }

  process.env.PM2_JSON_PROCESSING = true;

  // Get App list
  var appsName = [];
  var procList = {};

  appConf.forEach(function (app) {
    if (opts.only && opts.only !== app.name) {
      return false;
    }
    if (!app.watch && opts.watch && opts.watch === true) {
      app.watch = true;
    }
    if (!app.ignore_watch && opts.ignore_watch) { app.ignore_watch = opts.ignore_watch; }
    if (opts.instances && typeof (opts.instances) === 'number') { app.instances = opts.instances; }
    appsName.push(app.name);
  });

  that.Client.executeRemote('getMonitorData', {}, function (err, rawProcList) {
    if (err) {
      Common.printError(err);
      return cb ? cb(Common.retErr(err)) : that.exitCli(conf.ERROR_EXIT);
    }

    /**
     * Uniquify in memory process list
     */
    rawProcList.forEach(function (proc) {
      procList[proc.name] = proc;
    });

    /**
     * Auto detect application already started
     * and act on them depending on action
     */
    async.eachLimit(Object.keys(procList), conf.CONCURRENT_ACTIONS, function (procName, next) {
      // Skip app name (--only option)
      if (appsName.indexOf(procName) === -1) {
        return next();
      }

      if (!(action === 'reloadProcessId' ||
            action === 'softReloadProcessId' ||
            action === 'restartProcessId')) {
        throw new Error('Wrong action called');
      }

      // Get `env` from appConf by name
      async.filter(appConf, function (app, callback) {
        callback(app.name === procName);
      }, function (apps) {
        var envs = apps.map(function (app) {
          // Binds env_diff to env and returns it.
          return Common.mergeEnvironmentVariables(app, opts.env, deployConf);
        });

        // Assigns own enumerable properties of all
        // Notice: if people use the same name in different apps,
        //         duplicated envs will be overrode by the last one
        var env = envs.reduce(function (e1, e2) {
          return util._extend(e1, e2);
        });

        // When we are processing JSON, allow to keep the new env by default
        env.updateEnv = true;

        // Pass `env` option
        that._operate(action, procName, env, function (err, ret) {
          if (err) Common.printError(err);

          // For return
          appsInfo = appsInfo.concat(ret);

          that.Client.notifyGod(action, procName);
          // And Remove from array to spy
          appsName.splice(appsName.indexOf(procName), 1);
          return next();
        });
      });
    }, function (err) {
      if (err) return cb ? cb(Common.retErr(err)) : that.exitCli(conf.ERROR_EXIT);
      if (appsName.length > 0 && action !== 'start') {
        Common.printOut(conf.PREFIX_MSG_WARNING + 'Applications %s not running, starting...', appsName.join(', '));
      }
      // Start missing apps
      return startApps(appsName, function (err, apps) {
        appsInfo = appsInfo.concat(apps);
        return cb ? cb(err, appsInfo) : that.speedList(err ? 1 : 0);
      });
    });
    return false;
  });

  function startApps (nameToStart, cb) {
    var appsTostart = [];
    var appsStarted = [];

    appConf.forEach(function (app, i) {
      if (nameToStart.indexOf(app.name) !== -1) {
        appsTostart.push(appConf[i]);
      }
    });

    async.eachLimit(appsTostart, conf.CONCURRENT_ACTIONS, function (app, next) {
      if (opts.cwd) {
        app.cwd = opts.cwd;
      }
      if (opts.force_name) {
        app.name = opts.force_name;
      }
      if (opts.started_as_module) {
        app.pmx_module = true;
      }

      var resolvedPaths = null;

      try {
        resolvedPaths = Common.resolveAppAttributes({
          cwd: that.cwd,
          pm2_home: that.pm2_home
        }, app);
      } catch (e) {
        Common.printError(e);
        return cb ? cb(e) : that.exitCli(conf.ERROR_EXIT);
      }

      if (!resolvedPaths.env) resolvedPaths.env = {};

      // Set PM2 HOME in case of child process using PM2 API
      resolvedPaths.env['PM2_HOME'] = that.pm2_home;

      var additionalEnv = Modularizer.getAdditionalConf(resolvedPaths.name);
      util._extend(resolvedPaths.env, additionalEnv);

      resolvedPaths.env = Common.mergeEnvironmentVariables(resolvedPaths, opts.env, deployConf);

      delete resolvedPaths.env.current_conf;

      // Is KM linked?
      resolvedPaths.km_link = that.gl_is_km_linked;

      that.Client.executeRemote('prepare', resolvedPaths, function (err, data) {
        if (err) {
          Common.printError(conf.PREFIX_MSG + 'Process failed to launch', err);
          return next();
        }

        Common.printOut(conf.PREFIX_MSG + 'App [%s] launched (%d instances)', data[0].pm2_env.name, data.length);
        appsStarted = appsStarted.concat(data);
        next();
      });
    }, function (err) {
      return cb ? cb(err || null, appsStarted) : that.speedList();
    });
    return false;
  }
};

/**
 * Apply a RPC method on the json file
 * @private
 * @method actionFromJson
 * @param {string} action RPC Method
 * @param {object} options
 * @param {string|object} file file
 * @param {string} jsonVia action type (=only 'pipe' ?)
 * @param {Function}
 */
API.prototype.actionFromJson = function (action, file, opts, jsonVia, cb) {
  var appConf = {};
  var retProcesses = [];
  var that = this;

  // accept programmatic calls
  if (typeof file === 'object') {
    cb = typeof jsonVia === 'function' ? jsonVia : cb;
    appConf = file;
  } else if (jsonVia === 'file') {
    var data = null;

    try {
      data = fs.readFileSync(file);
    } catch (e) {
      Common.printError(conf.PREFIX_MSG_ERR + 'File ' + file + ' not found');
      return cb ? cb(Common.retErr(e)) : that.exitCli(conf.ERROR_EXIT);
    }

    try {
      appConf = Common.parseConfig(data, file);
    } catch (e) {
      Common.printError(conf.PREFIX_MSG_ERR + 'File ' + file + ' malformated');
      console.error(e);
      return cb ? cb(Common.retErr(e)) : that.exitCli(conf.ERROR_EXIT);
    }
  } else if (jsonVia === 'pipe') {
    appConf = Common.parseConfig(file, 'pipe');
  } else {
    Common.printError('Bad call to actionFromJson, jsonVia should be one of file, pipe');
    return that.exitCli(conf.ERROR_EXIT);
  }

  // Backward compatibility
  if (appConf.apps) {
    appConf = appConf.apps;
  }

  if (!Array.isArray(appConf)) {
    appConf = [appConf];
  }

  if ((appConf = Common.verifyConfs(appConf)) instanceof Error) {
    return cb ? cb(appConf) : that.exitCli(conf.ERROR_EXIT);
  }

  async.eachLimit(appConf, conf.CONCURRENT_ACTIONS, function (proc, next1) {
    var name = '';
    var newEnv;

    if (!proc.name) {
      name = path.basename(proc.script);
    } else {
      name = proc.name;
    }

    if (opts.only && opts.only !== name) {
      return process.nextTick(next1);
    }

    if (opts && opts.env) {
      newEnv = Common.mergeEnvironmentVariables(proc, opts.env);
    } else {
      newEnv = Common.mergeEnvironmentVariables(proc);
    }

    that.Client.getProcessIdByName(name, function (err, ids) {
      if (err) {
        Common.printError(err);
        return next1();
      }
      if (!ids) return next1();

      async.eachLimit(ids, conf.CONCURRENT_ACTIONS, function (id, next2) {
        var opts = {};

        // stopProcessId could accept options to?
        if (action === 'restartProcessId') {
          opts = {id: id, env: newEnv};
        } else {
          opts = id;
        }

        that.Client.executeRemote(action, opts, function (err, res) {
          retProcesses.push(res);
          if (err) {
            Common.printError(err);
            return next2();
          }

          if (action === 'restartProcessId') {
            that.Client.notifyGod('restart', id);
          } else if (action === 'deleteProcessId') {
            that.Client.notifyGod('delete', id);
          } else if (action === 'stopProcessId') {
            that.Client.notifyGod('stop', id);
          }

          Common.printOut(conf.PREFIX_MSG + '[%s](%d) \u2713', name, id);
          return next2();
        });
      }, function (err) {
        return next1(err, retProcesses);
      });
    });
  }, function (err) {
    if (cb) return cb(err, retProcesses);
    else return that.speedList();
  });
};

/**
 * Main function to operate with PM2 daemon
 *
 * @param {String} action_name  Name of action (restartProcessId, deleteProcessId, stopProcessId)
 * @param {String} process_name can be 'all', a id integer or process name
 * @param {Object} envs         object with CLI options / environment
 */
API.prototype._operate = function (actionName, processName, envs, cb) {
  var that = this;
  var updateEnv = false;
  var ret = [];

  // Make sure all options exist

  if (!envs) {
    envs = {};
  }

  if (typeof (envs) === 'function') {
    cb = envs;
    envs = {};
  }

  // Set via env.update (JSON processing)
  if (envs.updateEnv === true) {
    updateEnv = true;
  }

  if (!process.env.PM2_JSON_PROCESSING || envs.commands) {
    envs = that._handleAttributeUpdate(envs);
  }

  /**
   * Set current updated configuration if not passed
   */
  if (!envs.current_conf) {
    var _conf = fclone(envs);
    envs = {
      current_conf: _conf
    };

    // Is KM linked?
    envs.current_conf.km_link = that.gl_is_km_linked;
  }

  /**
   * Operate action on specific process id
   */
  function processIds (ids, cb) {
    Common.printOut(conf.PREFIX_MSG + 'Applying action %s on app [%s](ids: %s)', actionName, processName, ids);

    var concurrentActions = conf.CONCURRENT_ACTIONS;
    if (actionName === 'deleteProcessId') {
      concurrentActions = 10;
    }

    async.eachLimit(ids, concurrentActions, function (id, next) {
      var opts;

      // These functions need extra param to be passed
      if (actionName === 'restartProcessId' ||
          actionName === 'reloadProcessId' ||
          actionName === 'softReloadProcessId') {
        var newEnv = {};

        if (updateEnv === true) {
          if (conf.PM2_PROGRAMMATIC === true) {
            newEnv = Common.safeExtend({}, process.env);
          } else {
            newEnv = util._extend({}, process.env);
          }

          Object.keys(envs).forEach(function (k) {
            newEnv[k] = envs[k];
          });
        } else {
          newEnv = envs;
        }

        opts = {
          id: id,
          env: newEnv
        };
      } else {
        opts = id;
      }

      that.Client.executeRemote(actionName, opts, function (err, res) {
        if (err) {
          Common.printError(conf.PREFIX_MSG_ERR + 'Process %s not found', id);
          return next('Process not found');
        }

        if (actionName === 'restartProcessId') {
          that.Client.notifyGod('restart', id);
        } else if (actionName === 'deleteProcessId') {
          that.Client.notifyGod('delete', id);
        } else if (actionName === 'stopProcessId') {
          that.Client.notifyGod('stop', id);
        } else if (actionName === 'reloadProcessId') {
          that.Client.notifyGod('reload', id);
        } else if (actionName === 'softReloadProcessId') {
          that.Client.notifyGod('graceful reload', id);
        }

        if (!Array.isArray(res)) {
          res = [res];
        }

        // Filter return
        res.forEach(function (proc) {
          Common.printOut(conf.PREFIX_MSG + '[%s](%d) \u2713', proc.pm2_env ? proc.pm2_env.name : processName, id);

          if (!proc.pm2_env) return false;

          ret.push({
            name: proc.pm2_env.name,
            pm_id: proc.pm2_env.pm_id,
            status: proc.pm2_env.status,
            restart_time: proc.pm2_env.restart_time,
            pm2_env: {
              name: proc.pm2_env.name,
              pm_id: proc.pm2_env.pm_id,
              status: proc.pm2_env.status,
              restart_time: proc.pm2_env.restart_time,
              env: proc.pm2_env.env
            }
          });
        });

        return next();
      });
    }, function (err) {
      if (err) return cb ? cb(Common.retErr(err)) : that.exitCli(conf.ERROR_EXIT);
      return cb ? cb(null, ret) : that.speedList();
    });
  }

  if (processName === 'all') {
    that.Client.getAllProcessId(function (err, ids) {
      if (err) {
        Common.printError(err);
        return cb ? cb(Common.retErr(err)) : that.exitCli(conf.ERROR_EXIT);
      }
      if (!ids || ids.length === 0) {
        Common.printError(conf.PREFIX_MSG_WARNING + 'No process found');
        return cb ? cb(new Error('process name not found')) : that.exitCli(conf.ERROR_EXIT);
      }

      return processIds(ids, cb);
    });
  } else if (isNaN(processName)) {
    /**
     * We can not stop or delete a module but we can restart it
     * to refresh configuration variable
     */
    var allowModuleRestart = actionName === 'restartProcessId';

    that.Client.getProcessIdByName(processName, allowModuleRestart, function (err, ids) {
      if (err) {
        Common.printError(err);
        return cb ? cb(Common.retErr(err)) : that.exitCli(conf.ERROR_EXIT);
      }
      if (!ids || ids.length === 0) {
        Common.printError(conf.PREFIX_MSG_ERR + 'Process %s not found', processName);
        return cb ? cb(new Error('process name not found')) : that.exitCli(conf.ERROR_EXIT);
      }

      /**
       * Determine if the process to restart is a module
       * if yes load configuration variables and merge with the current environment
       */
      var additionalEnv = Modularizer.getAdditionalConf(processName);
      util._extend(envs, additionalEnv);

      return processIds(ids, cb);
    });
  } else {
    // Check if application name as number is an app name
    that.Client.getProcessIdByName(processName, function (ignoredErr, ids) {
      if (ids.length > 0) {
        return processIds(ids, cb);
      }
      // Else operate on pm id
      return processIds([processName], cb);
    });
  }
};

/**
 * Converts CamelCase Commander.js arguments
 * to Underscore
 * (nodeArgs -> node_args)
 */
API.prototype._handleAttributeUpdate = function (opts) {
  var conf = Config.transCMDToConf(opts);

  if (typeof (conf.name) !== 'string') {
    delete conf.name;
  }

  var argsIndex = 0;
  if (opts.rawArgs && (argsIndex = opts.rawArgs.indexOf('--')) >= 0) {
    conf.args = opts.rawArgs.slice(argsIndex + 1);
  }

  var appConf = Common.verifyConfs(conf)[0];

  if (appConf instanceof Error) {
    Common.printError('Error while transforming CamelCase args to underscore');
    return appConf;
  }

  if (argsIndex === -1) {
    delete appConf.args;
  }
  if (appConf.name === 'undefined') {
    delete appConf.name;
  }

  delete appConf.exec_mode;

  if (util.isArray(appConf.watch) && appConf.watch.length === 0) {
    if (!~opts.rawArgs.indexOf('--watch')) { delete appConf.watch; }
  }

  return appConf;
};

API.prototype.getProcessIdByName = function (name, cb) {
  var that = this;

  this.Client.getProcessIdByName(name, function (err, id) {
    if (err) {
      Common.printError(err);
      return cb ? cb(Common.retErr(err)) : that.exitCli(conf.ERROR_EXIT);
    }
    return cb ? cb(null, id) : that.exitCli(conf.SUCCESS_EXIT);
  });
};

/**
 * Description
 * @method jlist
 * @param {} debug
 * @return
 */
API.prototype.jlist = function (debug) {
  var that = this;

  that.Client.executeRemote('getMonitorData', {}, function (err, list) {
    if (err) {
      Common.printError(err);
      that.exitCli(conf.ERROR_EXIT);
    }

    if (debug) {
      process.stdout.write(util.inspect(list, false, null, false));
    } else {
      process.stdout.write(JSON.stringify(list));
    }

    that.exitCli(conf.SUCCESS_EXIT);
  });
};

var glRetry = 0;

/**
 * Description
 * @method speedList
 * @return
 */
API.prototype.speedList = function (code) {
  var that = this;

  // Do nothing if PM2 called programmatically and not called from CLI (also in exitCli)
  if (conf.PM2_PROGRAMMATIC && process.env.PM2_USAGE !== 'CLI') return false;

  that.Client.executeRemote('getMonitorData', {}, function (err, list) {
    if (err) {
      if (glRetry === 0) {
        glRetry += 1;
        return setTimeout(that.speedList.bind(that), 1400);
      }
      console.error('Error retrieving process list: %s.\nA process seems to be on infinite loop, retry in 5 seconds', err);
      return that.exitCli(conf.ERROR_EXIT);
    }
    if (process.stdout.isTTY === false) {
      UX.miniDisplay(list);
    } else if (commander.miniList && !commander.silent) {
      UX.miniDisplay(list);
    } else if (!commander.silent) {
      if (that.gl_interact_infos) {
        Common.printOut(chalk.green.bold('●') + ' Agent online - public key: %s - machine name: %s - Web access: https://app.keymetrics.io/', that.gl_interact_infos.public_key, that.gl_interact_infos.machine_name);
      }
      UX.dispAsTable(list, that.gl_interact_infos);
      Common.printOut(chalk.white.italic(' Use `pm2 show <id|name>` to get more details about an app'));
    }

    if (that.Client.daemon_mode === false) {
      Common.printOut('[--no-daemon] Continue to stream logs');
      Common.printOut('[--no-daemon] Exit on target PM2 exit pid=' + fs.readFileSync(conf.PM2_PID_FILE_PATH).toString());
      global._auto_exit = true;
      return that.streamLogs('all', 0, false, 'HH:mm:ss', false);
    } else {
      return that.exitCli(code !== undefined ? code : conf.SUCCESS_EXIT);
    }
  });
};

/**
 * Scale up/down a process
 * @method scale
 */
API.prototype.scale = function (appName, number, cb) {
  var that = this;

  function addProcs (proc, value, cb) {
    (function ex (proc, number) {
      if (number-- === 0) return cb();
      Common.printOut(conf.PREFIX_MSG + 'Scaling up application');
      that.Client.executeRemote('duplicateProcessId', proc.pm2_env.pm_id, ex.bind(this, proc, number));
    })(proc, number);
  }

  function rmProcs (procs, value, cb) {
    var i = 0;

    (function ex (procs, number) {
      if (number++ === 0) return cb();
      that._operate('deleteProcessId', procs[i++].pm2_env.pm_id, ex.bind(this, procs, number));
    })(procs, number);
  }

  function end () {
    return cb ? cb(null, {success: true}) : that.speedList();
  }

  this.Client.getProcessByName(appName, function (err, procs) {
    if (err) {
      Common.printError(err);
      return cb ? cb(Common.retErr(err)) : that.exitCli(conf.ERROR_EXIT);
    }

    if (!procs || procs.length === 0) {
      Common.printError(conf.PREFIX_MSG_ERR + 'Application %s not found', appName);
      return cb ? cb(new Error('App not found')) : that.exitCli(conf.ERROR_EXIT);
    }

    if (procs[0].pm2_env.exec_mode !== 'cluster_mode') {
      Common.printError(conf.PREFIX_MSG_ERR + 'Application %s is not in cluster mode', appName);
      return cb ? cb(new Error('App not in cluster mode')) : that.exitCli(conf.ERROR_EXIT);
    }

    var procNumber = procs.length;

    if (typeof (number) === 'string' && number.indexOf('+') >= 0) {
      number = parseInt(number, 10);
      return addProcs(procs[0], number, end);
    } else if (typeof (number) === 'string' && number.indexOf('-') >= 0) {
      number = parseInt(number, 10);
      return rmProcs(procs[0], number, end);
    } else {
      number = parseInt(number, 10);
      number = number - procNumber;

      if (number < 0) {
        return rmProcs(procs, number, end);
      } else if (number > 0) { return addProcs(procs[0], number, end); } else {
        Common.printError(conf.PREFIX_MSG_ERR + 'Nothing to do');
        return cb ? cb(new Error('Same process number')) : that.exitCli(conf.ERROR_EXIT);
      }
    }
  });
};

/**
 * Description
 * @method describeProcess
 * @param {} pm2_id
 * @return
 */
API.prototype.describe = function (pm2Id, cb) {
  var that = this;
  var foundProc = [];

  that.Client.executeRemote('getMonitorData', {}, function (err, list) {
    if (err) {
      Common.printError('Error retrieving process list: ' + err);
      that.exitCli(conf.ERROR_EXIT);
    }

    list.forEach(function (proc) {
      if ((!isNaN(pm2Id) && proc.pm_id === parseInt(pm2Id)) ||
          (typeof (pm2Id) === 'string' && proc.name === pm2Id)) {
        foundProc.push(proc);
      }
    });

    if (foundProc.length === 0) {
      Common.printError(conf.PREFIX_MSG_WARNING + '%s doesn\'t exist', pm2Id);
      return cb ? cb(null, []) : that.exitCli(conf.ERROR_EXIT);
    }

    if (!cb) {
      foundProc.forEach(function (proc) {
        UX.describeTable(proc);
      });
    }

    return cb ? cb(null, foundProc) : that.exitCli(conf.SUCCESS_EXIT);
  });
};

/**
 * Description
 * @method monit
 * @return
 */
API.prototype.monit = function (cb) {
  var that = this;

  var Monit = require('./API/Monit');

  if (cb) return cb(new Error('Monit cant be called programmatically'));

  Monit.init();

  function launchMonitor () {
    that.Client.executeRemote('getMonitorData', {}, function (err, list) {
      if (err) {
        console.error('Error retrieving process list: ' + err);
        that.exitCli(conf.ERROR_EXIT);
      }

      Monit.refresh(list);

      setTimeout(function () {
        launchMonitor();
      }, 400);
    });
  }

  launchMonitor();
};

/**
 * API method to perform a deep update of PM2
 * @method deepUpdate
 */
API.prototype.deepUpdate = function (cb) {
  var that = this;

  Common.printOut(conf.PREFIX_MSG + 'Updating PM2...');

  var exec = require('shelljs').exec;
  var child = exec('npm i -g pm2@latest; pm2 update', {async: true});

  child.stdout.on('end', function () {
    Common.printOut(conf.PREFIX_MSG + 'PM2 successfully updated');
    cb ? cb(null, {success: true}) : that.exitCli(conf.SUCCESS_EXIT);
  });
};
