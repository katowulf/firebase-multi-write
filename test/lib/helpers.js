var helpers = (function(helpers) {
   var isNode = typeof module !== "undefined" && module.exports;

   var sinon, _, FirebaseMultiWrite;
   if( isNode ) {
      sinon = require('sinon');
      var sinonChai = require("sinon-chai");
      require('chai').use(sinonChai);
      _ = require('lodash');
      FirebaseMultiWrite = require(require('path').join(__dirname, '../../FirebaseMultiWrite.js'));
   }
   else {
      sinon = window.sinon;
      _ = window._;
      FirebaseMultiWrite = window.FirebaseMultiWrite;
   }

   function MockFirebase(currentPath, data, parent, name) {
      // we use the actual data object here which can have side effects
      // important to keep in mind if you pass data here and then try to
      // use it later; we do this so that calling set on child paths
      // also updates the parent
      this.data = arguments.length? data : _.cloneDeep(helpers.DEFAULT_DATA);
      this.errs = {};
      this.currentPath = currentPath || '';
      this.ops = [];
      this.parent = parent||null;
      this.myName = name || null;
      this.flushDelay = false;
      this.children = [];
      parent && parent.children.push(this);

      for(var key in this) {
         if( typeof(this[key]) === 'function' ) {
            sinon.spy(this, key);
         }
      }
   }

   MockFirebase.prototype = {
      // return values for all the operations in order, with a setTimeout between each
      flush: function(delay) {
         var self = this;
         if( _.isNumber(delay) ) {
            setTimeout(self.flush.bind(self), delay);
         }
         else {
            self.ops.forEach(function(parts) {
               parts[0].apply(self, parts.slice(1));
            });
            self.ops = [];
            self.children.forEach(function(c) {
               c.flush();
            });
         }
         return self;
      },

      /** @param {int} [delay] */
      autoFlush: function(delay){
         this.flushDelay = _.isUndefined(delay)? true : delay;
         this.children.forEach(function(c) {
            c.autoFlush(delay);
         });
         this.flush();
         return this;
      },

      toString: function() {
         return 'MockFirebase'+this.currentPath;
      },

      child: function(childPath) {
         var ref = this, parts = childPath.split('/');
         parts.forEach(function(p) {
            var v = _.isObject(ref.data) && _.has(ref.data, p)? ref.data[p] : null;
            ref = new MockFirebase(mergePaths(ref.currentPath, p), v, ref, p);
         });
         ref.flushDelay = this.flushDelay;
         return ref;
      },

      set: function(data, cb) {
         this._defer(this._dataChanged, data, function() {
            cb && cb(this.errs['set']||null);
         });
         return this;
      },

      name: function() {
         return this.myName;
      },

      transaction: function(valueFn, finishedFn, applyLocally) {
         var valueSpy = sinon.spy(valueFn);
         var finishedSpy = sinon.spy(finishedFn);
         this._defer(function() {
            var err = this.errs['transaction']||null;
            var res = valueSpy(_.isObject(this.data)? _.extend(this.data) : _.isUndefined(this.data)? null : this.data);
            if( !_.isUndefined(res) && !err ) { this._dataChanged(res); }
            finishedSpy(err, err === null && !_.isUndefined(res), makeSnap(this, this.data));
         });
         return [valueSpy, finishedSpy, applyLocally];
      },

      _childChanged: function(name, data) {
         this.data[name] = data;
      },

      _dataChanged: function(data, cb) {
         this.data = data;
         if( this.parent && _.isObject(this.parent.data) ) {
            this.parent._childChanged(this.name(), data);
         }
         cb && cb.call(this);
      },

      _defer: function(fn) {
         this.ops.push(Array.prototype.slice.call(arguments, 0));
         if( this.flushDelay ) { this.flush(this.flushDelay); }
      }
   };

   helpers.MockFirebase = MockFirebase;

   helpers.ref = function(path, autoSyncDelay) {
      var ref = new MockFirebase();
      ref.flushDelay = _.isUndefined(autoSyncDelay)? true : autoSyncDelay;
      if( path ) { ref = ref.child(path); }
      return ref;
   };

   helpers.DEFAULT_DATA  = {
      'counters': {
         'MockFirebase%2Fdata%2Fa;MockFirebase%2Fdata%2Fb': 4
      },
      'data': {
         'a': {
            hello: 'world',
            number: 1,
            update_counter: 4,
            update_key: 'MockFirebase%2Fdata%2Fa;MockFirebase%2Fdata%2Fb'
         },
         'b': {
            foo: 'bar',
            number: 2,
            update_counter: 4,
            update_key: 'MockFirebase%2Fdata%2Fa;MockFirebase%2Fdata%2Fb'
         }
      }
   };

   (function() {
      helpers.runAfter = function(fn) {
         after.push(fn);
      };

      var after = [];
      afterEach(function(){
         _.each(after, function(fn) { fn(); });
         after = [];
      })
   })();

   helpers.logThis = function(level) {
      var oldLevel = FirebaseMultiWrite.ENABLE_LOGGING;
      FirebaseMultiWrite.ENABLE_LOGGING = _.isUndefined(level)? 4 : level;
      helpers.runAfter(function() {
         FirebaseMultiWrite.ENABLE_LOGGING = oldLevel;
      })
   };

   function mergePaths(base, add) {
      return base.replace(/\/$/, '')+'/'+add.replace(/^\//, '');
   }

   function makeSnap(ref, data) {
      return {
         val: function() { return data; },
         ref: function() { return ref; }
      }
   }

   return helpers;
})(typeof module !== "undefined" && module.exports? module.exports : {});