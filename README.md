firebase-multi-write
====================

Write to multiple paths in Firebase atomically.

## Do you need this?

Generally, you do not need this if:

  * you are not writing with high concurrency (hundreds of write opes per minute to the SAME record by DIFFERENT users)
  * your dependencies are straightforward (B depends on A, and C depends on A, but A does not depend on B or C)
  * your data can be merged into a single path

Developers are a bit too worried about orphaned records appearing in their data.
The chance of a web socket failing between one write and the other is probably trivial and somewhere on the order of collisions between
timestamp based IDs. That’s not to say it’s impossible, but it's generally low consequency, highly unlikely, and shouldn’t be your primary concern.

Also, orphans are extremely easy to clean up with a script or even just by typing a few lines of code into the JS console. So again,
they tend to be very low consequence.

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
    var pathToStoreUpdateCounters = fb.child('update_counters');
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

## How it works

Assuming the example shown under Usage above:

   1. When you call writer.commit(), a new ID is created in update_counters/counter/<code>hashOfPathUrls</code>/current.
   1. The write operations are committed using transactions, to ensure the counters match
   1. If another concurrent edit is made that updates the counters, the write is cancelled (the later update wins) and no writes take place
   1. If the counter is successfully updated, but one of the write ops fail for other reason, the writes are rolled back to the previous value (this is also done atomically and only if another update does not occur after this, if they cannot be reverted, then data may still become inconsistent
   1. A successful write places values into an audit log under update_counters/counter/<code>hashOfPathUrls</code>/audit/pathUrl