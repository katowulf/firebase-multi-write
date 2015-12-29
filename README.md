firebase-multi-write
====================

<p stlye="color:red">NOTE THAT WRITES TO MULTIPLE PATHS ARE NOW PART OF THE CORE API. See [this blog post](https://www.firebase.com/blog/2015-09-24-atomic-writes-and-more.html) for details.</p>

Write to multiple paths in Firebase atomically. This is done using an update_counter to enforce that concurrent writes cannot cause records to become out of sync, and by using rollbacks if any write op fails.

## Do you need this?

Generally, you do not need this if:

  * you are not writing with high concurrency (hundreds of write ops per minute to the SAME record by DIFFERENT users)
  * your dependencies are straightforward (B depends on A, and C depends on A, but A does not depend on B or C)
  * your data can be merged into a single path

Developers are a bit too worried about orphaned records appearing in their data.
The chance of a web socket failing between one write and the other is minor and, while not on the magnitude of collisions between
timestamp based IDs, still probably trivial. Since it's generally low consequence, highly unlikely, and extremely easy to clean up with a script or even just by typing a few lines of code into the JS console, it should not, generally speaking, be your primary concern.

## What can you do instead of this?

Put all the data that must be written atomically into a single path. Then you can write it as a single [set](https://www.firebase.com/docs/javascript/firebase/set.html) or a [transaction](https://www.firebase.com/docs/javascript/firebase/transaction.html) if necessary.

Or in the case where one record is the primary and the others depend on this, simply write the primary first, then write the others in the callback. Add security rules to enforce this, so that the primary record always exists before the others are allowed to write.

If you are denormalizing data simply to make it easy and fast to iterate (e.g. to obtain a list of names for users), then simply index that data in a separate path.
Then you can have the complete data record in a single path and the names, emails, etc in a fast, query/sort-friendly list.

## When is this useful?

This is an appropriate tool to use if you have a denormalized set of records that:

  * cannot be merged practically into one path in a practical way
  * have complex dependencies (A depends on C, and C depends on B, and B depends on A)
  * records are written with high concurrency (i.e. possibly hundreds of write ops per minute to the SAME record by DIFFERENT users)

## Installation

Include the script after Firebase:

    <script src="firebase-multi-write.js"></script>

Add security rules for your counters:

```json
"counters": {
   "$counter": {
      ".read": true,
      ".write": "newData.isNumber() && ( (!data.exists() && newData.val() === 1) || newData.val() === data.val() + 1 )"
   }
},
```

Create security rules on records to enforce the update counters:

```json
"$atomic_path": {
   ".read": true,
   // .validate allows these records to be deleted, use .write to prevent deletions
   ".validate": "newData.hasChildren(['update_counter', 'update_key']) && root.child('counters/'+newData.child('update_key').val()).val() === newData.child('update_counter').val()",
   "update_counter": {
      ".validate": "newData.isNumber()"
   },
   "update_key": {
      ".validate": "newData.isString()"
   }
}
```

## Usage

Create a new instance of FirebaseMultiWrite for each write operation.

    // connect to Firebase
    var fb = new Firebase('https://INSTANCE.firebaseio.com/');

    // create a new transaction
    var pathToStoreUpdateCounters = fb.child('counters');
    var transaction = new FirebaseMultiWrite( pathToStoreUpdateCounters );

    // add the data we will send
    transaction.set( fb.child('path1'), { /*... data ...*/ });
    transaction.set( fb.child('path2'), { /*... data ...*/ });

    // commit the changes
    transaction.commit(function(error) {
       if( error ) { /* failed, no data was written */ }
       else { /* success! all paths updated */ }
    });

## Limitations

   * As with all transactions, **do not call set** on paths where you use these commits
   * Do not try to use this with primitives
   * Transactions will be slow with many thousand writes per minute (at that point, you need to optimize writes to a smaller data set on a single path)
   * Loss of network connection which is never recovered (a very rare case) could still result in inconsistent records (see below)

In theory, if a network connection drops between two write ops, data could still become inconsistent. This is highly unlikely, since it requires multiple fail points all in the blink of any eye, but could occur.

For example, if one one write succeeds, network connection is lost, user shuts down browser and does not wait for reconnect (which for spotty access should come right back without them even knowing it's down). In this case, there is no way to rollback the successful write. 

However, the update counters are extremely helpful in this case to see that data is inconsistent. By comparing the counters between records, it would be simple to tell that they are out of sync. If this use case concerns you, keep an audit table with the last 3 or 4 writes and, in the case of a sync error, just revert to the last successful event.

## How it works

Assuming the example shown under Usage above:

   1. When you call transaction.commit(), a new ID is created in counters/<code>idForPathUrls</code>
   1. <code>idForPathUrls</code> represents a unique ID for the combination of paths being written (created by joining the set() paths with a ;)
   1. The write operations are committed using transactions, to ensure the counters match
   1. If another concurrent edit is made that updates the counters, the write is cancelled (the later update wins)
   1. If one of the write ops fails but another has already committed, we'll attempt to roll the successful op back to its previous value as well (if they cannot be reverted because security rules changed mid-stream or we lost connectivity, then data may still become inconsistent until the next update)
