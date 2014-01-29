(function () {
   "use strict";
   var isNode = typeof module !== "undefined" && module.exports;

   var expect, helpers, FirebaseMultiWrite, sinon, _;
   if( isNode ) {
      _ = require('lodash');
      expect = require('chai').expect;
      sinon = require('sinon');
      var sinonChai = require("sinon-chai");
      require('chai').use(sinonChai);

      var path = require('path');
      helpers = require(path.join(__dirname, 'lib/helpers.js'));
      FirebaseMultiWrite = require(path.join(__dirname, '../FirebaseMultiWrite.js'));
   }
   else {
      _ = window._;
      expect = window.chai.expect;
      helpers = window.helpers;
      sinon = window.sinon;
      FirebaseMultiWrite = window.FirebaseMultiWrite;
   }

   describe('FirebaseMultiWrite.js', function() {
      describe('API tests', function() {
         it('should return `this` when #set called', function() {
            var writer = new FirebaseMultiWrite(helpers.ref('counters'));
            var res = writer.set(helpers.ref('data/a'), {foo: 'bar'});
            expect(res).to.equal(writer);
         });

         it('should not allow commit to be called twice', function() {
            expect(function() {
               new FirebaseMultiWrite(helpers.ref('counters'))
                  .set(helpers.ref('data/a'), {foo: 'bar'})
                  .commit()
                  .commit()
            }).throws(Error, /already committed/);
         });

         it('should fail if set() not called before commit', function() {
            expect(function() {
               new FirebaseMultiWrite(helpers.ref('counters'))
                  .commit()
            }).throws(Error, /set.*called/);
         });

         it('should not allow a set after commit() is invoked', function() {
            expect(function() {
               new FirebaseMultiWrite(helpers.ref('counters'))
                  .set(helpers.ref('data/a'), {foo: 'bar'})
                  .commit()
                  .set()
            }).throws(Error, /already committed/);
         });

         it('should not allow non-object values for data', function() {
            expect(function() {
               new FirebaseMultiWrite(helpers.ref('counters'))
                  .set(helpers.ref('data/a'), true)
                  .commit()
                  .set()
            }).throws(Error, /an object/);
         });
      });

      describe('Update counter tests', function() {
         it('should create counter if it does not exist', function(done) {
            var counters = helpers.ref('counters');
            new FirebaseMultiWrite(counters)
               .set(helpers.ref('data/a'), {hello: 'world', number: 2})
               .commit(function() {
                  var counterRef = counters.child.getCall(0).returnValue;
                  expect(counterRef.data).to.equal(1);
                  expect(counterRef.transaction).calledOnce;
                  done();
               });
         });

         it('should increment counter when commit() is called', function(done) {
            var path1 = helpers.ref('data/a'), path2 = helpers.ref('data/b');
            var counters = helpers.ref('counters');
            new FirebaseMultiWrite(counters)
               .set(path1, {hello: 'world', number: 2})
               .set(path2, {foo: 'baz', number: 22})
               .commit(function() {
                  var counterRef = counters.child.getCall(0).returnValue;
                  expect(counterRef.data).to.equal(5);
                  expect(counterRef.transaction).calledOnce;
                  done();
               });
         });

         it('should set the update_counter in all write ops', function(done){
            var path1 = helpers.ref('data/a'), path2 = helpers.ref('data/b');
            var key = FirebaseMultiWrite.getCounterKey([path1, path2]);
            var counters = helpers.ref('counters');
            var writer = new FirebaseMultiWrite(counters)
               .set(path1, {hello: 'world', number: 2})
               .set(path2, {foo: 'baz', number: 22})
               .commit(function() {
                  expect(path1.data.update_counter).to.equal(5);
                  expect(path2.data.update_counter).to.equal(5);
                  done();
               });
         });

         it('should set the update_key in all write ops', function(done) {
            var path1 = helpers.ref('data/a'), path2 = helpers.ref('data/b');
            var key = FirebaseMultiWrite.getCounterKey([path1, path2]);
            var writer = new FirebaseMultiWrite(helpers.ref('counters'))
               .set(path1, {hello: 'world', number: 2})
               .set(path2, {foo: 'baz', number: 22})
               .commit(function() {
                  expect(path1.data.update_key).to.equal(key);
                  expect(path2.data.update_key).to.equal(key);
                  done();
               });
         });

      });

      describe('Write failure tests', function() {
         it('should fail all writes if one fails', function(done) {
            var path1 = helpers.ref('data/a'), path2 = helpers.ref('data/b', 10);
            var oldData = _.cloneDeep(path1.data);
            path2.errs['transaction'] = 'TEST_ERROR';
            new FirebaseMultiWrite(helpers.ref('counters'))
               .set(path1, {happy: 'joy'})
               .set(path2, {foo: 'bar'})
               .commit(function(err) {
                  expect(err).to.equal('TEST_ERROR');
                  expect(path1.data).to.eql(oldData);
                  done();
               });
         });

         it('should not invoke callback until all writes complete', function(done) {
            var path1 = helpers.ref('data/a', 35), path2 = helpers.ref('data/b', 25);
            new FirebaseMultiWrite(helpers.ref('counters', 50))
               .set(path1, {number: 50})
               .set(path2, {number: 99})
               .commit(function() {
                  expect(path1.transaction.getCall(0).returnValue[1]).calledOnce;
                  expect(path2.transaction.getCall(0).returnValue[1]).calledOnce;
                  done();
               });
         });

         it('should refuse to write if existing update_counter is higher than mine', function() {
            var dat = _.cloneDeep(helpers.DEFAULT_DATA);
            dat.data.a.update_counter = 99;
            var fb = new helpers.MockFirebase(null, dat.data);
            new FirebaseMultiWrite(fb.child('counters'))
               .set(fb.child('data/a'), {number: 250})
               .set(fb.child('data/b'), {number: 251})
               .commit(function(err) {
                  expect(err).to.equal('ROLLBACK');
               });
         });

         it('should fail if an update_counter moves during processing', function(done) {
            var path1 = helpers.ref('data/a', false), path2 = helpers.ref('data/b', false);
            var oldData1 = _.cloneDeep(path1.data), oldData2 = _.cloneDeep(path2.data);
            var key = FirebaseMultiWrite.getCounterKey([path1, path2]);
            var counters = helpers.ref('counters', false);
            new FirebaseMultiWrite(counters)
               .set(path1, {number: 50})
               .set(path2, {number: 99})
               .commit(function(err) {
                  expect(err).to.equal('ROLLBACK');
                  done();
               });
            counters.autoFlush();
            path1.autoFlush();
            path2.child('update_counter').set(99).flush();
            path2.autoFlush();
         });
      });

      describe('Rollback Tests', function() {
         it('should revert any committed writes on error', function(done) {
            var path1 = helpers.ref('data/a'), path2 = helpers.ref('data/b', false);
            var oldData1 = _.cloneDeep(path1.data), oldData2 = _.cloneDeep(path2.data);
            var key = FirebaseMultiWrite.getCounterKey([path1, path2]);
            var counters = helpers.ref('counters');
            new FirebaseMultiWrite(counters)
               .set(path1, {number: 50})
               .set(path2, {number: 99})
               .commit(function(err) {
                  expect(err).to.equal('OOPS');
                  expect(path1.data).to.eql(oldData1);
                  expect(path2.data).to.eql(oldData2);
                  done();
               });
            path2.errs['transaction'] = 'OOPS';
            path2.autoFlush();
         });
      });

   })
})();