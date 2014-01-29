(function() {

   /**
    * @param {Firebase} pathToUpdateCounters
    * @constructor
    */
   function FirebaseMultiWrite(pathToUpdateCounters) {
      this.counterPath = pathToUpdateCounters;
      this.committed = false;
      this.rollback = false;
      this.paths = [];
      this.data = [];
   }

   /**
    * @param {Firebase} path
    * @param {Object} data must be an object; no primitives allowed
    */
   FirebaseMultiWrite.prototype.set = function(path, data) {
      debug('.set(%s): %j', path, data);
      assertNotCommitted(this.committed);
      assertIsObject(data);
      this.data.push(data);
      this.paths.push(path);
      return this;
   };

   /**
    * @param {Function} [callback] function invoked with two arguments: error (string or null), updateCounter (number or null if error)
    */
   FirebaseMultiWrite.prototype.commit = function(callback) {
      debug('.commit(%s)', typeof(callback));
      assertNotCommitted(this.committed);
      assertSetCalled(this.paths);
      this.committed = true;
      var updateCounterKey = FirebaseMultiWrite.getCounterKey(this.paths);
      updateCounter(this, updateCounterKey, commitData.bind(null, this, callback||function() {}, updateCounterKey));
      return this;
   };

   /**
    * Cancel in-progress commit and rollback changes
    */
   FirebaseMultiWrite.prototype.abort = function() {
      this.rollback = true;
      return this;
   };

   /**
    * Set this to `true` for default logging or 1(errors), 2(errors+warnings), 3(errors,warnings,logs), 4(dev mode)
    * @type {boolean|int}
    */
   FirebaseMultiWrite.ENABLE_LOGGING = false;

   FirebaseMultiWrite.getCounterKey = function(paths) {
      var key = [];
      paths.forEach(function(p) {
         key.push(encodeKey(p.toString()));
      });
      return key.join(';');
   };

   /***********************************************
    * Private methods
    */

   function assertSetCalled(paths) {
      if( paths.length === 0 ) {
         throw new Error('FirebaseMultiWrite.commit() called but set() was never called');
      }
   }

   function assertNotCommitted(committed) {
      if( committed ) {
         throw new Error('FirebaseMultiWrite: instance already committed. Please create a new instance for each transaction');
      }
   }

   function assertIsObject(data) {
      if( !isObject(data) ) {
         throw new Error('FirebaseMultiWrite: data must be an object; primitives are not allowed');
      }
   }

   function updateCounter(trxn, updateCounterKey, next) {
      trxn.counterPath.child(updateCounterKey).transaction(function(current_value) {
         return (current_value||0)+1;
      }, function(err, committed, ss) {
         if( err ) logWarn(':updateCounter(%s) failed %s', updateCounterKey, err);
         else if( !committed ) log(':updateCounter(%s) did not commit (probably concurrent change)', updateCounterKey);
         else debug(':updateCounter(%s) set to %j', updateCounterKey, ss.val());
         next(err, committed? ss.val() : null);
      }, false);
   }

   function commitData(trxn, callback, updateKey, error, updateCounter) {
      if( error ) { callback(error, null); }
      else {
         var watcher = new Watcher();

         trxn.paths.forEach(function(path, i) {
            var data = trxn.data[i];
            data.update_counter = updateCounter;
            data.update_key = updateKey;
            doTrxn(trxn, path, data, updateCounter, watcher);
         });

         watcher.done(function(errs, results) {
            if( errs.length || trxn.rollback ) {
               log(':commitData - rolling back %d write ops', results && results.length || 0);
               rollback(results, trxn, updateKey, updateCounter, function() {
                  callback(errs.length? errs[0] : 'ROLLBACK', null);
               });
            }
            else {
               callback(null, updateCounter);
            }
         });
      }
   }

   function doTrxn(trxn, path, data, updateCounter, watcher) {
      var undef, res, oldValue;
      path.transaction(function(currValue) {
         if( trxn.rollback ) { return undef; }
         oldValue = copyData(currValue);
         if( currValue === null ) { currValue = { updateCounter: 0 }; }

         if( !isObject(currValue) ) {
            logWarn(':doTrxn(%s) contains a value which is not a valid object', path);
         }
         else if( typeof(currValue.update_counter) === 'number' && currValue.update_counter >= updateCounter ) {
            log(':doTrxn(%s) update_counter has increased, my edit lost', path);
         }
         else {
            res = data;
         }
         return res;
      }, watcher.handle(function(err, committed, ss) {
         if( err ) {
            trxn.abort();
            logError('.write(%s) failed: %s', path, err);
            return false;
         }
         else if( !committed ) {
            trxn.abort();
            logWarn('.write(%s) cancelled due to %s', path, trxn.rollback? 'rollback' : 'concurrent edit');
            return false;
         }
         else {
            debug(': wrote data to %s', path);
            return [path, oldValue, ss.val()];
         }
      }), false);
   }

   function rollback(results, trxn, updateKey, updateCounter, callback) {
      var undef;
      trxn.counterPath.child(updateKey).transaction(function(currValue) {
         if( currValue === updateCounter ) {
            return updateCounter-1;
         }
         return undef;
      }, function(err, committed, ss) {
         if( err ) {
            logError(': unable to roll back update_counter %s: %s', ss.ref().toString(), err);
            callback();
         }
         else if( !committed ) {
            log(': counter %s changed; rollback is now irrelevant', ss.ref().toString());
            callback();
         }
         else {
            var watcher = new Watcher();
            results.forEach(function(res) {
               if( res ) {
                  rollbackWriteOp(res[0], res[1], updateCounter, watcher.handle());
               }
            });
            watcher.done(callback);
         }
      }, false);
   }

   function rollbackWriteOp(path, oldVal, updateCounter, callback) {
      var undef;
      log(': changes already committed to path %s; attempting to revert to %j', path, oldVal);
      path.transaction(function(currValue) {
         if( isObject(currValue) && currValue.update_counter === updateCounter ) {
            return oldVal;
         }
         return undef;
      }, function(err, committed, ss) {
         if( err ) logError(err);
         else if( !committed ) log(': canceled rollback for path %s; update_counter has changed', path);
         else log(': reverted %s', path);
         callback();
      }, false);
   }

   /************************************************
    * Util functions
    */

   function encodeKey(url) {
      return (url||'').replace(/([.$\[\]#\/;])/g, function(m, p1) {
         return '%' + ((p1+'').charCodeAt(0).toString(16).toUpperCase());
      });
   }

   function logError() {
      if( logThis(1) ) {
         console.error(printf(Array.prototype.slice.call(arguments, 0)));
      }
   }

   function logWarn() {
      if( logThis(2) ) {
         console.warn(printf(Array.prototype.slice.call(arguments, 0)));
      }
   }

   function log() {
      if( logThis(3) ) {
         console.log(printf(Array.prototype.slice.call(arguments, 0)));
      }
   }

   function debug() {
      if( logThis(4) ) {
         console.log(printf(Array.prototype.slice.call(arguments, 0)));
      }
   }

   function logThis(x) {
      return typeof(console) !== 'undefined' && console.warn
         && FirebaseMultiWrite.ENABLE_LOGGING !== false &&
         (FirebaseMultiWrite.ENABLE_LOGGING === true || FirebaseMultiWrite.ENABLE_LOGGING >= x);
   }

   function printf(args) {
      var localArgs = args.slice(0); // make a copy
      var template = 'FirebaseMultiWrite'+localArgs.shift();
      var matches = template.match(/(%s|%d|%j)/g);
      matches && matches.forEach(function(m) {
         template = template.replace(m, format(localArgs.shift(), m));
      });
      return [template].concat(localArgs).join('\n');
   }

   function format(v, type) {
      switch(type) {
         case '%d':
            return parseInt(v, 10);
         case '%j':
            if( Array.isArray(v) ) {
               if(v.length > 500) {
                  v = v.substr(0, 500)+'.../*truncated*/...}';
               }
            }
            else {
               v =  isObject(v) && isObject(JSON)? JSON.stringify(v) : v+'';
            }
            return v;
         case '%s':
            return v + '';
         default:
            return v;
      }
   }

   function isObject(o) {
      return o && typeof(o) === 'object' && !Array.isArray(o);
   }

   function copyData(o) {
      var out;
      if( Array.isArray(o) ) {
         out = [];
         for(var i= 0, len = o.length; i < len; i++) {
            out.push(copyData(o[i]));
         }
      }
      else if( !isObject(o) ) {
         out = o;
      }
      else {
         out = {};
         var k;
         for (k in o) {
            if (o.hasOwnProperty(k)) {
               out[k] = copyData(o[k]);
            }
         }
      }
      return out;
   }

   /***********************************************
    * A simple watcher to wait for all transactions to complete
    * so we don't have to rely on a promise lib
    */
   function Watcher() {
      this.started = 0;
      this.finished = 0;
      this.errs = [];
      this.results = [];
      this.fns = [];
      this.doneCalled = false;
   }
   Watcher.prototype.handle = function(fn) {
      if( this.doneCalled ) {
         throw new Error('Watcher: done already called');
      }
      var self = this, pos = this.started++;
      debug('::Watcher - handle %d/%d', this.started, this.finished);
      return function(err) {
         var args = Array.prototype.slice.call(arguments, 0), res;
         if( fn ) {
            res = fn.apply(null, args);
         }
         if( err ) { self.errs.push(err); }
         self._handled(pos, res);
      }
   };

   Watcher.prototype.done = function(fn) {
      this.doneCalled = true;
      this.fns.push(fn);
      this._check();
   };

   Watcher.prototype._handled = function(pos, res) {
      this.results[pos] = res;
      this.finished++;
      debug('::Watcher - handled %d/%d', this.started, this.finished);
      this._check();
   };

   Watcher.prototype._check = function() {
      var errs = this.errs, results = this.results;
      if( this.finished === this.started ) {
         this.fns.forEach(function(fn) {
            fn(errs, results);
         })
      }
   };

   /***********************************************
    * IE 8 POLYFILLS
    */

   // credits: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/isArray
   if(!Array.isArray) {
      Array.isArray = function (vArg) {
         return Object.prototype.toString.call(vArg) === "[object Array]";
      };
   }

   // credits: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/forEach
   if (!Array.prototype.forEach) {
      Array.prototype.forEach = function(fun /*, thisArg */) {
         "use strict";

         if (this === void 0 || this === null)
            throw new TypeError();

         var t = Object(this);
         var len = t.length >>> 0;
         if (typeof fun !== "function")
            throw new TypeError();

         var thisArg = arguments.length >= 2 ? arguments[1] : void 0;
         for (var i = 0; i < len; i++) {
            if (i in t)
               fun.call(thisArg, t[i], i, t);
         }
      };
   }

   // credits: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/bind
   if (!Function.prototype.bind) {
      Function.prototype.bind = function (oThis) {
         if (typeof this !== "function") {
            // closest thing possible to the ECMAScript 5 internal IsCallable function
            throw new TypeError("Function.prototype.bind - what is trying to be bound is not callable");
         }

         var aArgs = Array.prototype.slice.call(arguments, 1),
            fToBind = this,
            fNOP = function () {},
            fBound = function () {
               return fToBind.apply(this instanceof fNOP && oThis
                  ? this
                  : oThis,
                  aArgs.concat(Array.prototype.slice.call(arguments)));
            };

         fNOP.prototype = this.prototype;
         fBound.prototype = new fNOP();

         return fBound;
      };
   }

   /*********************************************
    * Deploy
    */

   var isNode = typeof module !== "undefined" && module.exports;
   var isAMD = typeof define === 'function' && typeof define.amd === 'object' && define.amd;

   if( isAMD ) {
      define(function(){
         return FirebaseMultiWrite;
      });
   }
   else if( isNode ) {
      module.exports = FirebaseMultiWrite;
   }
   else {
      window.FirebaseMultiWrite = FirebaseMultiWrite;
   }
})();