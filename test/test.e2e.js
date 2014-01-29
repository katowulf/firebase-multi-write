(function () {
   "use strict";
   var isNode = typeof module !== "undefined" && module.exports;

   var expect, helpers, FirebaseMultiWrite, sinon, _, Firebase, URL;
   if( isNode ) {
      _ = require('lodash');
      expect = require('chai').expect;
      sinon = require('sinon');
      var sinonChai = require("sinon-chai");
      require('chai').use(sinonChai);

      var path = require('path');
      helpers = require(path.join(__dirname, 'lib/helpers.js'));
      FirebaseMultiWrite = require(path.join(__dirname, '../FirebaseMultiWrite.js'));
      Firebase = require('firebase');
      URL = process.env.E2E_URL;
   }
   else {
      _ = window._;
      expect = window.chai.expect;
      helpers = window.helpers;
      sinon = window.sinon;
      FirebaseMultiWrite = window.FirebaseMultiWrite;
      Firebase = window.Firebase;
      URL = getParm('E2E_URL');
   }

   describe('End-to-end Test', function() {
      it('should work with a real Firebase connection', function(done) {
         if( !URL ) {
            throw new Error('You must supply the E2E_URL '+(isNode? 'environment variable' : 'url parameter')+', which should point to your Firebase URL, in order to run the e2e test');
         }
         var fb = new Firebase(URL);
         var pa = fb.child('data/a');
         var pb = fb.child('data/b');
         var key = FirebaseMultiWrite.getCounterKey([pa, pb]);
         var data = _.cloneDeep(helpers.DEFAULT_DATA);
         data.counters[key] = 1;
         fb.set(data, function() {
            new FirebaseMultiWrite(fb.child('counters'))
               .set(pa, {hello: 'world'})
               .set(pb, {foo: 'bar'})
               .commit(function(err) {
                  expect(err).to.be.null;
                  pa.once('value', function(snap) {
                     var da = snap.val();
                     expect(da).not.null;
                     expect(da.hello).to.equal('world');
                     expect(da.update_counter).to.equal(2);
                     expect(da.update_key).to.equal(key);
                     pb.once('value', function(snap) {
                        var db = snap.val();
                        expect(db).not.null;
                        expect(db.foo).to.equal('bar');
                        expect(db.update_counter).to.equal(2);
                        expect(db.update_key).to.equal(key);
                        done();
                     })
                  })
               })
         });
      });
   });

   //credits: http://stackoverflow.com/questions/979975/how-to-get-the-value-from-url-parameter
   function getParm(name) {
      var QueryString = function () {
         // This function is anonymous, is executed immediately and
         // the return value is assigned to QueryString!
         var query_string = {};
         var query = window.location.search.substring(1);
         var vars = query.split("&");
         for (var i=0;i<vars.length;i++) {
            var pair = vars[i].split("=");
            // If first entry with this name
            if (typeof query_string[pair[0]] === "undefined") {
               query_string[pair[0]] = pair[1];
               // If second entry with this name
            } else if (typeof query_string[pair[0]] === "string") {
               var arr = [ query_string[pair[0]], pair[1] ];
               query_string[pair[0]] = arr;
               // If third or later entry with this name
            } else {
               query_string[pair[0]].push(pair[1]);
            }
         }
         return query_string;
      } ();
      console.log(QueryString);
      return QueryString[name];
   }

})();