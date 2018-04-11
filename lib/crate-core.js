const EventEmitter = require('events').EventEmitter;

const VVwE = require('version-vector-with-exceptions');
const LSEQTree = require('lseqtree');

const Foglet = require('foglet-core').Foglet
const Communication = require('foglet-core').communication

const MInsertOperation = require('./messages.js').MInsertOperation;
const MAEInsertOperation = require('./messages.js').MAEInsertOperation;
const MRemoveOperation = require('./messages.js').MRemoveOperation;
const MCaretMovedOperation = require('./messages.js').MCaretMovedOperation;

const MAntiEntropyRequest = require('./messages.js').MAntiEntropyRequest;
const MAntiEntropyResponse = require('./messages.js').MAntiEntropyResponse;
const MBroadcast = require('./messages').MBroadcast;


/*!
 * \brief link together all components of the model of the CRATE editor
 * \param id the unique site identifier
 * \param options the webrtc specific options 
 */


class CrateCore extends EventEmitter {

    constructor(id, options, data_comm, behaviours_comm) {
        super()
        // EventEmitter.call(this);

        this.options = options

        this._communication = data_comm

        this.No_antientropy = behaviours_comm

        this.broadcast = this._communication.broadcast
        // Default channel for antientropy operations : insert, remove, changeTitle

        // No-anti-entropy channel for the operations that dose not need antientropy : ping, cartet position

        // listen for incoming broadcast
        window.No_antientropy = this.No_antientropy;

        this.No_antientropy.onBroadcast((id, message) => {
            switch (message.type) {
                case 'MCaretMovedOperation':
                    this.remoteCaretMoved(message.range, message.origin);
                    break;
                case 'Mping':
                    this.ping(message.origin, message.pseudo);
                    break;
            };

        })

        this._communication.onBroadcast((id, message) => {
            switch (message.type) {
                case 'MRemoveOperation':
                    this.remoteRemove(message.remove, message.origin);
                    break;
                case 'MInsertOperation':
                    this.remoteInsert(message.insert, message.origin);
                    break;
                case 'MTitleChanged':
                    this.changeTitle(message.title);
                    break;

            };

        })

        this._communication.broadcast.startAntiEntropy(2000);
        this._communication.broadcast.on('antiEntropy', (id, remoteVVwE, localVVwE) => {
            var remoteVVwE = (new VVwE(null)).constructor.fromJSON(remoteVVwE); // cast
            var toSearch = [];
            // #1 for each entry of our VVwE, look if the remote VVwE knows less
            for (var i = 0; i < localVVwE.vector.arr.length; ++i) {
                var localEntry = localVVwE.vector.arr[i];
                var index = remoteVVwE.vector.indexOf(localVVwE.vector.arr[i]);
                var start = 1;
                // #A check if the entry exists in the remote vvwe
                if (index >= 0) {
                    start = remoteVVwE.vector.arr[index].v + 1;
                };
                for (var j = start; j <= localEntry.v; ++j) {
                    // #B check if not one of the local exceptions
                    if (localEntry.x.indexOf(j) < 0) {
                        toSearch.push({
                            _e: localEntry.e,
                            _c: j
                        });
                    };
                };
                // #C handle the exceptions of the remote vector
                if (index >= 0) {
                    for (var j = 0; j < remoteVVwE.vector.arr[index].x.length; ++j) {
                        var except = remoteVVwE.vector.arr[index].x[j];
                        if (localEntry.x.indexOf(except) < 0 && except <= localEntry.v) {
                            toSearch.push({
                                _e: localEntry.e,
                                _c: except
                            });
                        };
                    };
                };
            };

            var elements = this.getElements(toSearch);

            // #2 send back the found elements

            if (elements.length != 0) {
                this._communication.broadcast.sendAntiEntropyResponse(id, localVVwE, elements);
                this.sendChangeTitle(crate_model.name);
            }
        })

        this.id = id
        this.sequence = new LSEQTree(this.id);
    }


    /*!
     * \brief create the core from an existing object
     * \param object the object to initialize the core model of crate containing a 
     * sequence and causality tracking metadata
     */
    init(object) {
        // import the sequence and version vector, yet it keeps the identifier of
        // this instance of the core.

        // this.broadcast = Object.assign(new VVwE(this.id),object.causality);

        // var local = this.broadcast.causality.local;
        this.broadcast._causality = this.broadcast._causality.constructor.fromJSON(object.causality);


        // this.broadcast.causality.local = local;
        var local = this.broadcast._causality.local;
        // this.broadcast.causality.vector.insert(this.broadcast.causality.local);

        this.No_antientropy.broadcast._causality.local.e = local.e;

        this.sequence.fromJSON(object.sequence);
        this.sequence._s = local.e;
        this.sequence._c = local.v;
    };

    /*!
     * \brief local insertion of a character inside the sequence structure. It
     * broadcasts the operation to the rest of the network.
     * \param character the character to insert in the sequence
     * \param index the index in the sequence to insert
     * \return the identifier freshly allocated
     */
    insert(character, index) {
        var ei = this.sequence.insert(character, index);
        var id = {_e: ei._i._s[ei._i._s.length-1], _c: ei._i._c[ei._i._c.length-1]};
        // this.broadcast.send(new MInsertOperation(ei, id._e), id, null);
        this._communication.sendBroadcast(new MInsertOperation(ei, id))
        return ei;
    };

    /*!
     * \brief local deletion of a character from the sequence structure. It 
     * broadcasts the operation to the rest of the network.
     * \param index the index of the element to remove
     * \return the identifier freshly removed
     */
    remove(index) {
        var i = this.sequence.remove(index);
        this.sequence._c += 1;
        this._communication.sendBroadcast(new MRemoveOperation(i, store.get('myId').id))
        return i;
    };


    /*!
     * \brief insertion of an element from a remote site. It emits 'remoteInsert' 
     * with the index of the element to insert, -1 if already existing.
     * \param ei the result of the remote insert operation
     * \param origin the origin id of the insert operation
     */
    remoteInsert(ei, origin) {
        debugger
        var index = this.sequence.applyInsert(ei._e, ei._i, false);
        this.emit('remoteInsert', ei._e, index);
        if (index >= 0 && origin) {
            this.emit('remoteCaretMoved', {
                index: index,
                length: 0
            }, origin._e);
        };

    };

    /*!
     * \brief removal of an element from a remote site.  It emits 'remoteRemove'
     * with the index of the element to remove, -1 if does not exist
     * \param id the result of the remote insert operation
     * \param origin the origin id of the removal
     */
    remoteRemove(id, origin) {
        var index = this.sequence.applyRemove(id);
        this.emit('remoteRemove', index);
        if (index >= 0 && origin) {
            this.emit('remoteCaretMoved', {
                index: index,
                length: 0
            }, origin);
        };
    };

    /**
     * [remoteCaretMoved]
     * @param  {[type]} range  [description]
     * @param  {[type]} origin [description]
     * @return {[type]}        [description]
     */
    remoteCaretMoved(range, origin) {
        this.emit('remoteCaretMoved', range, origin);
    };



    /**
     * [caretMoved description]
     * @param  {[type]} range [description]
     * @return {[type]}       [description]
     */
    caretMoved(range) {
        this.No_antientropy.sendBroadcast(new MCaretMovedOperation(range, store.get('myId').id));
        return range;
    };



    /**
     * [ping At ping recepion send ping event to be traited]
     * @param  {[type]} origin [description]
     * @param  {[type]} pseudo [description]
     * @return {[type]}        [description]
     */
    ping(origin, pseudo) {
        this.emit('ping', origin, pseudo);
    };


    /**
     * [sendPing description]
     * @return {[type]} [description]
     */
    sendPing() {
        var pseudo = "Anonymous";
        if (store.get('myId').pseudo) {
            pseudo = store.get('myId').pseudo;
        }

        this.No_antientropy.sendBroadcast({
            type: 'Mping',
            origin: store.get('myId').id,
            pseudo: pseudo
        });
        return origin;
    };



    /**
     * [changeTitle At the reception of MTitleChanged ]
     * @param  {[type]} title [description]
     * @return {[type]}       [description]
     */

    changeTitle(title) {
        this.emit('changeTitle', title);
    };


    /**
     * [sendChangeTitle Broadcast the new title]
     * @param  {[type]} title [description]
     * @return {[type]}       [description]
     */
    sendChangeTitle(title) {
        this._communication.sendBroadcast({
            type: 'MTitleChanged',
            title: title
        })
        return origin;
    };


    /*!
     * \brief search a set of elements in our sequence and return them
     * \param toSearch the array of elements {_e, _c} to search
     * \returns an array of nodes
     */
    getElements(toSearch) {
        var result = [],
            found, node, tempNode, i = this.sequence.length,
            j = 0;
        // (TODO) improve research by exploiting the fact that if a node is
        // missing, all its children are missing too.
        // (TODO) improve the returned representation: either a tree to factorize
        // common parts of the structure or identifiers to get the polylog size
        // (TODO) improve the search by using the fact that toSearch is a sorted
        // array, possibly restructure this argument to be even more efficient
        while (toSearch.length > 0 && i <= this.sequence.length && i > 0) {
            node = this.sequence.get(i);
            tempNode = node;

            
            while (tempNode.children.length > 0) {
                tempNode = tempNode.children[0];
            };
            j = 0;
            found = false;
            while (j < toSearch.length && !found) {
                if (tempNode.t.s === toSearch[j]._e &&
                    tempNode.t.c === toSearch[j]._c) {

                    found = true;
                    result.push(new MAEInsertOperation({
                        _e: tempNode.e,
                        _i: node
                    }, {
                        e: toSearch[j]._e,
                        c: toSearch[j]._c
                    }));
                    toSearch.splice(j, 1);
                } else {
                    ++j;
                };
            };
            --i;
        };
        return result;



    };
}
module.exports = CrateCore;