var EventEmitter = require('events').EventEmitter;
var util = require('util');

//var Spray = require('./spray-wrtc/lib/spray.js');
var Spray = require('spray-wrtc');
var CausalBroadcast = require('./CausalBroadcastDefinition/lib/causalbroadcast.js');
var VVwE = require('./version-vector-with-exceptions/lib/vvwe.js');
var LSEQTree = require('./LSEQTree/lib/lseqtree.js');
var GUID = require('./guid.js');
const Foglet = require('foglet-core').Foglet
const Communication = require('foglet-core').communication


var MInsertOperation = require('./messages.js').MInsertOperation;
var MAEInsertOperation = require('./messages.js').MAEInsertOperation;
var MRemoveOperation = require('./messages.js').MRemoveOperation;
var MCaretMovedOperation = require('./messages.js').MCaretMovedOperation;

var MAntiEntropyRequest = require('./messages.js').MAntiEntropyRequest;
var MAntiEntropyResponse = require('./messages.js').MAntiEntropyResponse;
var MBroadcast = require('./messages').MBroadcast;



util.inherits(CrateCore, EventEmitter);
/*!
 * \brief link together all components of the model of the CRATE editor
 * \param id the unique site identifier
 * \param options the webrtc specific options 
 */

function CrateCore(id, options) {

    self = this;
    EventEmitter.call(this);

    this.options = options;

    this.fogletOptions = {
        id,
        verbose: true, // want some logs ? switch to false otherwise
        rps: {
            options: {
                protocol: options.signalingOptions.session, // foglet running on the protocol foglet-example, defined for spray-wrtc
                webrtc: options.webRTCOptions,
                timeout: 2 * 60 * 1000, // spray-wrtc timeout before definitively close a WebRTC connection.
                delta: 10 * 1000, // spray-wrtc shuffle interval
                signaling: {
                    address: 'http://172.16.9.214:3000/',
                    // signalingAdress: 'https://signaling.herokuapp.com/', // address of the signaling server
                    room: options.signalingOptions.session // room to join
                }
            }
        }
    }

    this.app = new Foglet(this.fogletOptions)
    this.No_antientropy = new Communication(this.app.overlay().network, "No-anti-entropy")
    this.broadcast = this.app.overlay()._communication.broadcast
    // Default channel for antientropy operations : insert, remove, changeTitle



    // No-anti-entropy channel for the operations that dose not need antientropy : ping, cartet position

    window.app = this.app;

    // connect to the signaling server
    this.app.share()

  
    // connect our app to the fog
    this.app.connection()
        .then(() => {
            console.log('application connected!')
            // listen for incoming broadcast
            window.No_antientropy = this.No_antientropy;
            this.No_antientropy.onBroadcast((id, message) => {
                switch (message.type) {
                    case 'MCaretMovedOperation':
                        self.remoteCaretMoved(message.range, message.origin);
                        break;
                    case 'Mping':
                        self.ping(message.origin, message.pseudo);
                        break;
                };

            })


            this.app.onBroadcast((id, message) => {
                switch (message.type) {
                    case 'MRemoveOperation':
                        self.remoteRemove(message.remove, message.origin);
                        break;
                    case 'MInsertOperation':
                        self.remoteInsert(message.insert, message.origin);
                        break;
                    case 'MTitleChanged':
                        self.changeTitle(message.title);
                        break;

                };

            })


            // this.app.broadcast=this.app._networkManager._rps.communication.broadcast

            // this.app.overlay().communication.broadcast._unicast.on('receive', (id, message) => {console.log(id, message)})  
            this.app.overlay().communication.broadcast.startAntiEntropy(2000);
            this.app.overlay().communication.broadcast.on('antiEntropy', (id, remoteVVwE, localVVwE) => {
                // console.log(" on antiEntropy",id, remoteVVwE, localVVwE)
                var remoteVVwE = (new VVwE(null)).fromJSON(remoteVVwE); // cast
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
                this.app.overlay().communication.broadcast.sendAntiEntropyResponse(id, localVVwE, elements);



            })
        })
        .catch(console.error) // catch connection errors
    this.id = id

    this.sequence = new LSEQTree(this.id);


}


/*!
 * \brief create the core from an existing object
 * \param object the object to initialize the core model of crate containing a 
 * sequence and causality tracking metadata
 */
CrateCore.prototype.init = function(object) {
    // import the sequence and version vector, yet it keeps the identifier of
    // this instance of the core.

    // this.broadcast = Object.assign(new VVwE(this.id),object.causality);

    debugger;
    // var local = this.broadcast.causality.local;
    this.broadcast._causality= this.broadcast._causality.constructor.fromJSON(object.causality);
 

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
CrateCore.prototype.insert = function(character, index) {
    var ei = this.sequence.insert(character, index);
    // this.broadcast.send(new MInsertOperation(ei, id._e), id, null);
    this.app.sendBroadcast(new MInsertOperation(ei, store.get('myId').id))
    return ei;
};

/*!
 * \brief local deletion of a character from the sequence structure. It 
 * broadcasts the operation to the rest of the network.
 * \param index the index of the element to remove
 * \return the identifier freshly removed
 */
CrateCore.prototype.remove = function(index) {
    var i = this.sequence.remove(index);
    this.sequence._c += 1;
    this.app.sendBroadcast(new MRemoveOperation(i, store.get('myId').id))
    return i;
};


/*!
 * \brief insertion of an element from a remote site. It emits 'remoteInsert' 
 * with the index of the element to insert, -1 if already existing.
 * \param ei the result of the remote insert operation
 * \param origin the origin id of the insert operation
 */
CrateCore.prototype.remoteInsert = function(ei, origin) {
    var index = this.sequence.applyInsert(ei._e, ei._i, false);
    // 
    this.emit('remoteInsert', ei._e, index);
    if (index >= 0 && origin) {
        this.emit('remoteCaretMoved', {
            index: index,
            length: 0
        }, origin);
    };

};

/*!
 * \brief removal of an element from a remote site.  It emits 'remoteRemove'
 * with the index of the element to remove, -1 if does not exist
 * \param id the result of the remote insert operation
 * \param origin the origin id of the removal
 */
CrateCore.prototype.remoteRemove = function(id, origin) {
    var index = this.sequence.applyRemove(id);
    this.emit('remoteRemove', index);
    if (index >= 0 && origin) {
        this.emit('remoteCaretMoved', {
            index: index,
            length: 0
        }, origin);
    };
};

CrateCore.prototype.remoteCaretMoved = function(range, origin) {
    this.emit('remoteCaretMoved', range, origin);
};



CrateCore.prototype.caretMoved = function(range) {
    this.No_antientropy.sendBroadcast(new MCaretMovedOperation(range, store.get('myId').id));
    return range;
};


// At ping recepion send ping event to be traited
CrateCore.prototype.ping = function(origin, pseudo) {
    this.emit('ping', origin, pseudo);
};


// to broadcast a ping in the network
CrateCore.prototype.sendPing = function() {
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


// At the reception of MTitleChanged 
CrateCore.prototype.changeTitle = function(title) {
    this.emit('changeTitle', title);
};


// Broadcast the new title
CrateCore.prototype.sendChangeTitle = function(title) {
    this.app.sendBroadcast({
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
CrateCore.prototype.getElements = function(toSearch) {
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

module.exports = CrateCore;