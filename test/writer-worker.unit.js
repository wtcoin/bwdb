'use strict';

var chai = require('chai');
var should = chai.should();
var sinon = require('sinon');
var EventEmitter = require('events').EventEmitter;
var BloomFilter = require('bloom-filter');
var lmdb = require('node-lmdb');
var net = require('net');

var WriterWorker = require('../lib/writer-worker.js');
var utils = require('../lib/utils');
var db = require('../lib/db');
var WalletBlock = require('../lib/models/block');
var messages = require('../lib/messages');
var models = require('../lib/models');

/* jshint maxstatements:100 */
describe('Wallet Writer Worker', function() {
  var options = {
    network: 'testnet',
    bitcoinHeight: 100,
    bitcoinHash: '00000000000000000495aa8f7662444b0e26cbcbe1a2311b10d604eaa7df319e',
    listen: 44333,
    configPath: process.env.HOME,
    clientsConfig: [
      {
        protocol: 'http',
        rpchost: 'localhost',
        rpcport: 18333,
        rpcuser: 'testuser',
        rpcpassword: 'testpassword',
        rpcstrict: true
      }
    ]
  };

  describe('@constructor', function() {
    it('create an instance of writer worker', function() {
      var worker = new WriterWorker(options);
      should.exist(worker);
      worker.network.name.should.equal('testnet');
      worker.listen.should.equal(44333);
      worker.bitcoinHash.should.equal('00000000000000000495aa8f7662444b0e26cbcbe1a2311b10d604eaa7df319e');
      worker.bitcoinHeight.should.equal(100);
      worker.clientsConfig.should.deep.equal(options.clientsConfig);
    });
  });
  describe('#_tryAllClients', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will retry for each node client', function(done) {
      var clients = [
        {
            getInfo: sinon.stub().callsArgWith(0, new Error('test'))
        },
        {
            getInfo: sinon.stub().callsArgWith(0, new Error('test'))
        },
        {
          getInfo: sinon.stub().callsArg(0)
        }
      ];
      sandbox.stub(utils, 'getClients', function() {
        return clients;
      });
      var worker = new WriterWorker(options);
      worker._tryAllClients(function(client, next) {
        client.getInfo(next);
      }, {interval: 100}, function(err) {
        if (err) {
          return done(err);
        }
        clients[0].getInfo.callCount.should.equal(1);
        clients[1].getInfo.callCount.should.equal(1);
        clients[2].getInfo.callCount.should.equal(1);
        done();
      });
    });
    it('will get error if all clients fail', function(done) {
      var clients = [
        {
          getInfo: sinon.stub().callsArgWith(0, new Error('2'))
        },
        {
          getInfo: sinon.stub().callsArgWith(0, new Error('3'))
        },
        {
          getInfo: sinon.stub().callsArgWith(0, new Error('1'))
        }
      ];
      sandbox.stub(utils, 'getClients', function() {
        return clients;
      });
      var worker = new WriterWorker(options);
      worker._tryAllClients(function(client, next) {
        client.getInfo(next);
      }, {interval:100}, function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        err.message.should.equal('1');
        clients[0].getInfo.callCount.should.equal(1);
        clients[1].getInfo.callCount.should.equal(1);
        clients[2].getInfo.callCount.should.equal(1);
        done();
      });
    });
  });
  describe('#_loadLatestWalletBlock', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will load latest wallet block', function(done) {
      var worker = new WriterWorker(options);
      var txn = {
        abort: sinon.stub()
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn)
        }
      };
      var block;
      var cursor = {
        getCurrentBinary: function(func) {
          block = new WalletBlock(10, {
            blockHash: new Buffer('0b925ce878f804390cf4d845a150ee142a167339d3984796c01a2efb6b5a3ce4', 'hex')
          });
          var hexKey = block.getKey('hex');
          var serialized = block.getValue();
          func(hexKey, serialized);
        },
        goToLast: sinon.stub().returns(true),
        close: sinon.stub()
      };
      sandbox.stub(lmdb, 'Cursor', function() {
        return cursor;
      });
      var expectedWalletBlock = {addressFilter: BloomFilter.create(100, 0.1)};
      sandbox.stub(models.WalletBlock, 'fromBuffer').returns(expectedWalletBlock);
      worker._loadLatestWalletBlock(function() {
        worker.walletBlock.should.equal(expectedWalletBlock);
        done();
      });
    });
    it('will callback without retrieving latest wallet block', function() {
      var worker = new WriterWorker(options);
      var txn = {
        abort: sinon.stub()
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn)
        }
      };
      var block;
      var cursor = {
        getCurrentBinary: function(func) {
          block = new WalletBlock(10, {
            blockHash: new Buffer('0b925ce878f804390cf4d845a150ee142a167339d3984796c01a2efb6b5a3ce4', 'hex')
          });
          var hexKey = block.getKey('hex');
          var serialized = block.getValue();
          func(hexKey, serialized);
        },
        goToLast: sinon.stub().returns(false),
        close: sinon.stub()
      };
      sandbox.stub(lmdb, 'Cursor', function() {
        return cursor;
      });
      var callback = function() {
        should.not.exist(worker.walletBlock);
      };
      worker._loadLatestWalletBlock(callback);
    });
  });
  describe('#_setupDatabase', function() {
    var callback = sinon.stub();
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will set up the database', function() {
      sandbox.stub(utils, 'setupDirectory').callsArg(1);
      sandbox.stub(db, 'open', function() {
        return 'some db instance';
      });
      var worker = new WriterWorker(options);
      worker._setupDatabase(callback);
      utils.setupDirectory.callCount.should.equal(1);
      utils.setupDirectory.args[0][0].should.equal(process.env.HOME + '/testnet3.lmdb');
      db.open.callCount.should.equal(1);
      db.open.args[0][0].should.equal(process.env.HOME + '/testnet3.lmdb');
      callback.callCount.should.equal(1);
    });
  });
  describe('#_startListener', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will start a listener with default priority', function(done) {
      var socket = new EventEmitter();
      var server = new EventEmitter();
      server.listen = sinon.stub().callsArg(1);

      sandbox.stub(net, 'createServer').callsArgWith(0, socket).returns(server);
      var task = {};
      sandbox.stub(messages, 'parser', function(fn) {
        return function() {
          fn({task:task});
        };
      });
      var worker = new WriterWorker(options);
      worker.queue = {
        length: sinon.stub.returns(0),
        push: sinon.stub()
      };
      worker._sendResponse = sinon.stub();
      socket.once('data', function() {
        /* check for conditions */
        setImmediate(function() {
          worker.queue.push.callCount.should.equal(1);
          worker.queue.push.args[0][0].should.equal(task);
          task.socket.should.equal(socket);
          worker.queue.push.args[0][1].should.equal(10);
          done();
        });
      });
      worker._startListener(function() {
        socket.emit('data', 'something');
      });
    });
    it('will start a listener with priority set', function(done) {
      var socket = new EventEmitter();
      var server = new EventEmitter();
      server.listen = sinon.stub().callsArg(1);
      sandbox.stub(net, 'createServer').callsArgWith(0, socket).returns(server);

      var task = {};
      sandbox.stub(messages, 'parser', function(fn) {
        return function() {
          fn({task:task, priority: 5});
        };
      });
      var worker = new WriterWorker(options);
      worker.queue = {
        length: sinon.stub.returns(0),
        push: sinon.stub()
      };
      worker._sendResponse = sinon.stub();
      socket.once('data', function() {
        /* check for conditions */
        setImmediate(function() {
          worker.queue.push.callCount.should.equal(1);
          worker.queue.push.args[0][0].should.equal(task);
          task.socket.should.equal(socket);
          worker.queue.push.args[0][1].should.equal(5);
          done();
        });
      });
      worker._startListener(function() {
        socket.emit('data', 'something');
      });
    });
    it('will send error if queue is full', function(done) {
      var socket = new EventEmitter();
      var server = new EventEmitter();
      server.listen = sinon.stub().callsArg(1);
      sandbox.stub(net, 'createServer').callsArgWith(0, socket).returns(server);

      var task = {id:2};
      sandbox.stub(messages, 'parser', function(fn) {
        return function() {
          fn({task:task, priority: 5});
        };
      });
      var worker = new WriterWorker(options);
      worker.queue = {
        length: sinon.stub().returns(worker.maxWorkQueue),
        push: sinon.stub()
      };
      worker._sendResponse = sinon.stub();
      socket.once('data', function() {
        /* check for conditions */
        setImmediate(function() {
          worker.queue.push.callCount.should.equal(0);
          worker._sendResponse.callCount.should.equal(1);
          worker._sendResponse.args[0][0].should.equal(socket);
          worker._sendResponse.args[0][1].should.equal(2);
          done();
        });
      });
      worker._startListener(function() {
        socket.emit('data', 'something');
      });
    });
    it('will send error when trying to start listener', function(done) {
      var socket = new EventEmitter();
      var server = new EventEmitter();
      server.listen = sinon.stub().callsArg(1);
      sandbox.stub(net, 'createServer').callsArgWith(0, socket).returns(server);

      var task = {id: 2};
      sandbox.stub(messages, 'parser', function(fn) {
        return function() {
          fn({task:task, priority: 5});
        };
      });
      var worker = new WriterWorker(options);
      sandbox.stub(console, 'error');
      worker.queue = {
        length: sinon.stub().returns(worker.maxWorkQueue),
        push: sinon.stub()
      };
      worker._sendResponse = sinon.stub();
      var error = new Error('error message');
      server.once('error', function() {
        setImmediate(function() {
          console.error.callCount.should.equal(1);
          console.error.args[0][0].should.equal(error);
          done();
        });
      });
      worker._startListener(function() {
        server.emit('error', error);
      });
    });
  });
  describe('#start', function() {
    var callback = sinon.stub();
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will start writer worker', function() {
      var worker = new WriterWorker(options);
      sandbox.stub(utils, 'setupDirectory').callsArg(1);
      sandbox.stub(worker, '_setupDatabase').callsArg(0);
      sandbox.stub(worker, '_loadLatestWalletBlock').callsArg(0);
      sandbox.stub(worker, '_startListener').callsArg(0);
      worker.start(callback);
      utils.setupDirectory.callCount.should.equal(1);
      utils.setupDirectory.args[0][0].should.equal(process.env.HOME);
      worker._setupDatabase.callCount.should.equal(1);
      worker._loadLatestWalletBlock.callCount.should.equal(1);
      worker._startListener.callCount.should.equal(1);
      callback.callCount.should.equal(1);
    });
  });
  describe('#_initWalletBlock', function() {
    it('will initialize the wallet block', function() {
      var worker = new WriterWorker(options);
      var wb = worker._initWalletBlock();
      should.exist(wb);
      wb.height.should.equal(options.bitcoinHeight);
      wb.blockHash.toString('hex').should.equal(options.bitcoinHash);
    });
    it('will return false', function() {
      var worker = new WriterWorker(options);
      var wb = worker._initWalletBlock();
      wb = worker._initWalletBlock();
      wb.should.equal(false);
    });
  });
  describe('#stop', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will stop the writer worker', function(done) {
      var worker = new WriterWorker(options);
      worker._server = {
        close: sinon.stub()
      };
      worker.db = 'some db instance';
      sandbox.stub(db, 'close');
      worker.stop(function() {
        worker._server.close.callCount.should.equal(1);
        db.close.callCount.should.equal(1);
        done();
      });
    });
    it('callback issued (_server and web not defined)', function(done) {
      var worker = new WriterWorker(options);
      worker.stop(function() {
        done();
      });
    });
  });
  describe('#_sendResponse', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will write response msg to socket', function() {
      var worker = new WriterWorker(options);
      var socket = {
        write: sinon.stub()
      };
      sandbox.stub(messages, 'encodeMessage', function() {
        return 'encoded message';
      });
      worker._sendResponse(socket, 10, null, {hello: 'world'});
      messages.encodeMessage.callCount.should.equal(1);
      messages.encodeMessage.args[0][0].should.equal(JSON.stringify({
        id: 10,
        error: null,
        result: {
          hello: 'world'
        }
      }));
      socket.write.callCount.should.equal(1);
      socket.write.args[0][0].should.equal('encoded message');
    });
  });
  describe('#_queueWorkerIterator', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will return queue method expected parameters error', function() {
      var worker = new WriterWorker(options);
      var next = sinon.stub();
      var task = {
        method: 'importWalletAddresses'
      };
      worker._sendResponse = sinon.stub();
      worker._initQueue(options);
      worker._queueWorkerIterator(task, next);
      worker._sendResponse.callCount.should.equal(1);
      worker._sendResponse.args[0][2].should.deep.equal({ message: 'Expected 2 parameter(s)'});
    });
    it('will return method not found error', function() {
      var worker = new WriterWorker(options);
      var next = sinon.stub();
      var task = {
        method: 'unknownMethod'
      };
      worker._sendResponse = sinon.stub();
      worker._initQueue(options);
      worker._queueWorkerIterator(task, next);
      worker._sendResponse.callCount.should.equal(1);
      worker._sendResponse.args[0][2].should.deep.equal({ message: 'Method Not Found'});
    });
    it('calls a method with given parameters', function() {
      var worker = new WriterWorker(options);
      var next = sinon.stub();
      var socket = {
        write: sinon.stub()
      };
      var task = {
        method: 'importWalletAddresses',
        params: ['first', 'second'],
        socket: socket,
        id: 10
      };

      worker._sendResponse = sinon.stub();
      worker.importWalletAddresses = sinon.stub().callsArgWith(2, null, {});
      worker._initQueue(options);
      worker._queueWorkerIterator(task, next);
      worker.importWalletAddresses.callCount.should.equal(1);
      worker.importWalletAddresses.args[0][0].should.equal('first');
      worker.importWalletAddresses.args[0][1].should.equal('second');
      worker._sendResponse.callCount.should.equal(1);
      worker._sendResponse.args[0][0].should.equal(socket);
      worker._sendResponse.args[0][1].should.equal(task.id);
      should.equal(worker._sendResponse.args[0][2], null);
      worker._sendResponse.args[0][3].should.deep.equal({});
    });
    it('calls a method with given parameters and returns error', function() {
      var worker = new WriterWorker(options);
      var next = sinon.stub();
      var socket = {
        write: sinon.stub()
      };
      var task = {
        method: 'importWalletAddresses',
        params: ['first', 'second'],
        socket: socket,
        id: 10
      };

      worker._sendResponse = sinon.stub();
      worker.importWalletAddresses = sinon.stub().callsArgWith(2, new Error('error message'));
      worker._initQueue(options);
      worker._queueWorkerIterator(task, next);
      worker.importWalletAddresses.callCount.should.equal(1);
      worker.importWalletAddresses.args[0][0].should.equal('first');
      worker.importWalletAddresses.args[0][1].should.equal('second');
      worker._sendResponse.callCount.should.equal(1);
      worker._sendResponse.args[0][0].should.equal(socket);
      worker._sendResponse.args[0][1].should.equal(task.id);
      worker._sendResponse.args[0][2].should.deep.equal({message: 'error message'});
    });
  });
  describe('#_addUTXO', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will add utxos by txid ouput index, satoshis and height', function() {
      var worker = new WriterWorker(options);
      var utxoData = {
        satoshis: 1000000,
        height: 100,
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a',
        index: 10,
        address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
      };
      var txn = {
        putBinary: sinon.stub()
      };
      var walletId = new Buffer('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', 'hex');
      var utxos = {};
      var utxosBySatoshis = {};
      var utxosByHeight = {};
      worker.db = {
        utxos: utxos,
        utxosBySatoshis: utxosBySatoshis,
        utxosByHeight: utxosByHeight
      };
      var utxo = {
        getKey: sinon.stub().returns('utxokey'),
        getValue: sinon.stub().returns('utxovalue')
      };

      sandbox.stub(models.WalletUTXO, 'create').returns(utxo);
      sandbox.stub(models.WalletUTXOBySatoshis, 'create').returns(utxo);
      sandbox.stub(models.WalletUTXOByHeight, 'create').returns(utxo);

      worker._addUTXO(txn, walletId, utxoData);
      txn.putBinary.callCount.should.equal(3);
      txn.putBinary.args[0][0].should.deep.equal(utxos);
      txn.putBinary.args[0][1].should.equal('utxokey');
      txn.putBinary.args[0][2].should.equal('utxovalue');
      models.WalletUTXO.create.callCount.should.equal(1);
      models.WalletUTXO.create.args[0][0].should.equal(walletId);
      models.WalletUTXO.create.args[0][1].should.deep.equal(utxoData);
      utxo.getKey.callCount.should.equal(3);
      utxo.getKey.args[0][0].should.equal('hex');
      utxo.getValue.callCount.should.equal(3);

      txn.putBinary.args[1][0].should.deep.equal(utxosBySatoshis);
      txn.putBinary.args[1][1].should.equal('utxokey');
      txn.putBinary.args[1][2].should.equal('utxovalue');
      models.WalletUTXO.create.callCount.should.equal(1);
      models.WalletUTXO.create.args[0][0].should.equal(walletId);
      models.WalletUTXO.create.args[0][1].should.deep.equal(utxoData);
      utxo.getKey.args[1][0].should.equal('hex');

      txn.putBinary.args[0][0].should.deep.equal(utxos);
      txn.putBinary.args[0][1].should.equal('utxokey');
      txn.putBinary.args[0][2].should.equal('utxovalue');
      models.WalletUTXO.create.callCount.should.equal(1);
      models.WalletUTXO.create.args[0][0].should.equal(walletId);
      models.WalletUTXO.create.args[0][1].should.deep.equal(utxoData);
      utxo.getKey.args[2][0].should.equal('hex');
    });
  });
  describe('#_undoAddUTXO', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will del utxos by txid ouput index, satoshis and height', function() {
      var worker = new WriterWorker(options);
      var utxoData = {
        satoshis: 1000000,
        height: 100,
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a',
        index: 10,
        address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
      };
      var txn = {
        del: sinon.stub()
      };
      var walletId = new Buffer('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', 'hex');
      var utxos = {};
      var utxosBySatoshis = {};
      var utxosByHeight = {};
      worker.db = {
        utxos: utxos,
        utxosBySatoshis: utxosBySatoshis,
        utxosByHeight: utxosByHeight
      };
      var utxo = {
        getKey: sinon.stub().returns('utxokey'),
        getValue: sinon.stub().returns('utxovalue')
      };

      sandbox.stub(models.WalletUTXO, 'create').returns(utxo);
      sandbox.stub(models.WalletUTXOBySatoshis, 'create').returns(utxo);
      sandbox.stub(models.WalletUTXOByHeight, 'create').returns(utxo);

      worker._undoAddUTXO(txn, walletId, utxoData);
      txn.del.callCount.should.equal(3);
      txn.del.args[0][0].should.deep.equal(utxos);
      txn.del.args[0][1].should.equal('utxokey');
      models.WalletUTXO.create.callCount.should.equal(1);
      models.WalletUTXO.create.args[0][0].should.equal(walletId);
      models.WalletUTXO.create.args[0][1].should.deep.equal(utxoData);
      utxo.getKey.callCount.should.equal(3);
      utxo.getKey.args[0][0].should.equal('hex');

      txn.del.args[1][0].should.deep.equal(utxosBySatoshis);
      txn.del.args[1][1].should.equal('utxokey');
      models.WalletUTXO.create.callCount.should.equal(1);
      models.WalletUTXO.create.args[0][0].should.equal(walletId);
      models.WalletUTXO.create.args[0][1].should.deep.equal(utxoData);
      utxo.getKey.args[1][0].should.equal('hex');

      txn.del.args[0][0].should.deep.equal(utxos);
      txn.del.args[0][1].should.equal('utxokey');
      models.WalletUTXO.create.callCount.should.equal(1);
      models.WalletUTXO.create.args[0][0].should.equal(walletId);
      models.WalletUTXO.create.args[0][1].should.deep.equal(utxoData);
      utxo.getKey.args[2][0].should.equal('hex');
    });
  });
  describe('#_removeUTXO', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will remove utxo by txid ouput index, satoshis and height', function() {
      var worker = new WriterWorker(options);
      var delta = {
        prevtxid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a',
        prevout: 100
      };
      var spentOutputs = {};
      var expectedGetBinary = new Buffer('buffer', 'hex');
      var txn = {
        getBinary: sinon.stub().returns(expectedGetBinary),
        del: sinon.stub()
      };
      var walletId = new Buffer('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', 'hex');
      var utxos = {};
      var utxosBySatoshis = {};
      var utxosByHeight = {};
      worker.db = {
        utxos: utxos,
        utxosBySatoshis: utxosBySatoshis,
        utxosByHeight: utxosByHeight
      };
      var utxo = {
        toObject: sinon.stub()
      };

      sandbox.stub(models.WalletUTXO, 'fromBuffer').returns(utxo);
      sandbox.stub(models.WalletUTXO, 'getKey').returns('utxokey');
      sandbox.stub(models.WalletUTXOBySatoshis, 'getKey').returns('satoshiUTXOKey');
      sandbox.stub(models.WalletUTXOByHeight, 'getKey').returns('heightUTXOKey');

      worker._removeUTXO(txn, walletId, delta, spentOutputs);

      models.WalletUTXO.getKey.callCount.should.equal(1);
      models.WalletUTXO.getKey.args[0][0].should.equal(walletId);
      models.WalletUTXO.getKey.args[0][1].should.equal(delta.prevtxid);
      models.WalletUTXO.getKey.args[0][2].should.equal(delta.prevout);
      models.WalletUTXO.getKey.args[0][3].should.equal('hex');

      txn.getBinary.callCount.should.equal(1);
      txn.getBinary.args[0][0].should.deep.equal(utxos);
      txn.getBinary.args[0][1].should.equal('utxokey');

      models.WalletUTXO.fromBuffer.callCount.should.equal(1);
      models.WalletUTXO.fromBuffer.args[0][0].should.equal('utxokey');
      models.WalletUTXO.fromBuffer.args[0][1].should.equal(expectedGetBinary);

      txn.del.callCount.should.equal(3);
      txn.del.args[0][0].should.deep.equal(utxos);
      txn.del.args[0][1].should.equal('utxokey');
      txn.del.args[1][0].should.equal(utxosBySatoshis);
      txn.del.args[1][1].should.equal('satoshiUTXOKey');
      txn.del.args[2][0].should.equal(utxosByHeight);
      txn.del.args[2][1].should.equal('heightUTXOKey');
    });
  });
  describe('#_undoRemoveUTXO', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will undo remove utxos by txid ouput index, satoshis and height', function() {
      var worker = new WriterWorker(options);
      var delta = {
        prevtxid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a',
        prevout: 100
      };
      var spentOutputs = {
        utxokey: 'undo information is not available to restore utxo'
      };
      var txn = {
        putBinary: sinon.stub()
      };
      var walletId = new Buffer('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', 'hex');
      var utxos = {};
      var utxosBySatoshis = {};
      var utxosByHeight = {};
      worker.db = {
        utxos: utxos,
        utxosBySatoshis: utxosBySatoshis,
        utxosByHeight: utxosByHeight
      };
      var utxoData = {
        satoshis: 1000000,
        height: 100,
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a',
        index: 10,
        address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
      };
      var utxo = {
        getValue: sinon.stub().returns('utxovalue'),
        getKey: sinon.stub().returns('utxostubreturn'),
        toObject: sinon.stub().returns(utxoData)
      };
      sandbox.stub(models, 'WalletUTXO').returns(utxo);

      sandbox.stub(models.WalletUTXO, 'create').returns(utxo);
      sandbox.stub(models.WalletUTXOBySatoshis, 'create').returns(utxo);
      sandbox.stub(models.WalletUTXOByHeight, 'create').returns(utxo);

      sandbox.stub(models.WalletUTXO, 'getKey').returns('utxokey');

      worker._undoRemoveUTXO(txn, walletId, delta, spentOutputs);

      models.WalletUTXO.getKey.callCount.should.equal(1);
      models.WalletUTXO.getKey.args[0][0].should.equal(walletId);
      models.WalletUTXO.getKey.args[0][1].should.equal(delta.prevtxid);
      models.WalletUTXO.getKey.args[0][2].should.equal(delta.prevout);
      models.WalletUTXO.getKey.args[0][3].should.equal('hex');

      models.WalletUTXO.callCount.should.equal(1);
      models.WalletUTXO.args[0][0].should.equal('undo information is not available to restore utxo');

      txn.putBinary.callCount.should.equal(4);
      txn.putBinary.args[0][0].should.equal(utxos);
      txn.putBinary.args[0][1].should.equal('utxokey');
      txn.putBinary.args[0][2].should.equal('utxovalue');

      txn.putBinary.args[1][0].should.equal(utxos);
      txn.putBinary.args[1][1].should.equal('utxostubreturn');
      txn.putBinary.args[1][2].should.equal('utxovalue');

      txn.putBinary.args[2][0].should.equal(utxosBySatoshis);
      txn.putBinary.args[2][1].should.equal('utxostubreturn');
      txn.putBinary.args[2][2].should.equal('utxovalue');

      txn.putBinary.args[3][0].should.equal(utxosByHeight);
      txn.putBinary.args[3][1].should.equal('utxostubreturn');
      txn.putBinary.args[3][2].should.equal('utxovalue');
    });
  });
  describe('#_connectUTXO', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('adds UTXOs to wallet if satoshis in delta', function() {
      var worker = new WriterWorker(options);
      var walletId = new Buffer('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', 'hex');
      var delta = {
        satoshis: 10000000,
        index: 10,
        address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
      };
      var txn = {};
      var transaction = {
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a'
      };
      var height = 10;
      var spentOutputs = {};
      sandbox.stub(worker, '_addUTXO');
      worker._connectUTXO(txn, walletId, height, transaction, delta, spentOutputs);
      worker._addUTXO.callCount.should.equal(1);
      worker._addUTXO.args[0][0].should.equal(txn);
      worker._addUTXO.args[0][1].should.equal(walletId);
      worker._addUTXO.args[0][2].should.deep.equal({
        satoshis: delta.satoshis,
        height: height,
        txid: transaction.txid,
        index: delta.index,
        address: delta.address
      });
    });
    it('removes UTXOs from wallet if satoshis not in delta', function() {
      var worker = new WriterWorker(options);
      var walletId = new Buffer('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', 'hex');
      var delta = {
        satoshis: 0,
        index: 10,
        address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
      };
      var txn = {};
      var transaction = {
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a'
      };
      var height = 10;
      var spentOutputs = {};
      sandbox.stub(worker, '_removeUTXO');
      worker._connectUTXO(txn, walletId, height, transaction, delta, spentOutputs);
      worker._removeUTXO.callCount.should.equal(1);
      worker._removeUTXO.args[0][0].should.equal(txn);
      worker._removeUTXO.args[0][1].should.equal(walletId);
      worker._removeUTXO.args[0][2].should.deep.equal(delta);
      worker._removeUTXO.args[0][3].should.deep.equal(spentOutputs);
    });
  });
  describe('#_disconnectUTXO', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('undo add UTXOs to wallet if satoshis in delta', function() {
      var worker = new WriterWorker(options);
      var walletId = new Buffer('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', 'hex');
      var delta = {
        satoshis: 10000000,
        index: 10,
        address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
      };
      var txn = {};
      var transaction = {
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a'
      };
      var height = 10;
      var spentOutputs = {};
      sandbox.stub(worker, '_undoAddUTXO');
      worker._disconnectUTXO(txn, walletId, height, transaction, delta, spentOutputs);
      worker._undoAddUTXO.callCount.should.equal(1);
      worker._undoAddUTXO.args[0][0].should.equal(txn);
      worker._undoAddUTXO.args[0][1].should.equal(walletId);
      worker._undoAddUTXO.args[0][2].should.deep.equal({
        satoshis: delta.satoshis,
        height: height,
        txid: transaction.txid,
        index: delta.index,
        address: delta.address
      });
    });
    it('undo remove UTXOs from wallet if satoshis not in delta', function() {
      var worker = new WriterWorker(options);
      var walletId = new Buffer('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', 'hex');
      var delta = {
        satoshis: 0,
        index: 10,
        address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
      };
      var txn = {};
      var transaction = {
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a'
      };
      var height = 10;
      var spentOutputs = {};
      sandbox.stub(worker, '_undoRemoveUTXO');
      worker._disconnectUTXO(txn, walletId, height, transaction, delta, spentOutputs);
      worker._undoRemoveUTXO.callCount.should.equal(1);
      worker._undoRemoveUTXO.args[0][0].should.equal(txn);
      worker._undoRemoveUTXO.args[0][1].should.equal(walletId);
      worker._undoRemoveUTXO.args[0][2].should.deep.equal(delta);
      worker._undoRemoveUTXO.args[0][3].should.deep.equal(spentOutputs);
    });
  });
  describe('#_connectTransaciton', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('connect transaction from list of inputs and outputs', function(done) {
      var worker = new WriterWorker(options);
      var walletId = new Buffer('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', 'hex');
      var binaryBuf = new Buffer('some value' , 'hex');
      var txn = {
        getBinary: sinon.stub().returns(binaryBuf),
        putBinary: sinon.stub()
      };
      var transaction = {
        inputs: [
          {
            satoshis: -100000000,
            index: 10,
            address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
          }
        ],
        outputs: [
          {
            satoshis: 100000000,
            index: 10,
            address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
          }
        ],
        index: 100,
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a'
      };
      var txid = {
        getKey: sinon.stub().returns('90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a'),
        getValue: sinon.stub().returns('some value')
      };
      var height = 10;
      var spentOutputs = {};
      var wallets = {};
      var wallet = {
        addBalance: sinon.stub()
      };
      sandbox.stub(models.WalletAddressMap, 'getKey').returns('address map key');
      sandbox.stub(utils, 'splitBuffer').returns([walletId]);
      sandbox.stub(models.WalletTxid, 'create').returns(txid);
      sandbox.stub(models.Wallet, 'fromBuffer').returns(wallet);
      worker.db = {
        addressesMap: {},
        wallets: {},
        txids: {}
      };
      worker._connectUTXO = sinon.stub();

      worker._connectTransaction(txn, wallets, height, transaction, spentOutputs, function() {

        models.WalletAddressMap.getKey.callCount.should.equal(2);
        models.WalletAddressMap.getKey.args[0][0].should.equal(transaction.inputs[0].address);
        models.WalletAddressMap.getKey.args[0][1].should.equal('hex');
        models.WalletAddressMap.getKey.args[0][2].name.should.equal(options.network);

        models.WalletAddressMap.getKey.args[1][0].should.equal(transaction.outputs[0].address);
        models.WalletAddressMap.getKey.args[1][1].should.equal('hex');
        models.WalletAddressMap.getKey.args[1][2].name.should.equal(options.network);

        txn.getBinary.callCount.should.equal(3);
        txn.getBinary.args[0][0].should.deep.equal(worker.db.addressesMap);
        txn.getBinary.args[0][1].should.equal('address map key');

        txn.getBinary.args[1][0].should.deep.equal(worker.db.wallets);
        txn.getBinary.args[1][1].should.equal(walletId.toString('hex'));

        txn.getBinary.args[2][0].should.deep.equal(worker.db.addressesMap);
        txn.getBinary.args[2][1].should.equal('address map key');

        models.WalletTxid.create.callCount.should.equal(2);
        models.WalletTxid.create.args[0][0].should.equal(walletId);
        models.WalletTxid.create.args[0][1].should.equal(height);
        models.WalletTxid.create.args[0][2].should.equal(transaction.index);
        models.WalletTxid.create.args[0][3].should.equal(transaction.txid);

        models.WalletTxid.create.args[1][0].should.equal(walletId);
        models.WalletTxid.create.args[1][1].should.equal(height);
        models.WalletTxid.create.args[1][2].should.equal(transaction.index);
        models.WalletTxid.create.args[1][3].should.equal(transaction.txid);

        txn.putBinary.callCount.should.equal(2);
        txn.putBinary.args[0][0].should.equal(worker.db.txids);
        txn.putBinary.args[0][1].should.equal('90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a');
        txn.putBinary.args[0][2].should.equal('some value');

        worker._connectUTXO.callCount.should.equal(2);
        worker._connectUTXO.args[0][0].should.equal(txn);
        worker._connectUTXO.args[0][1].should.equal(walletId);
        worker._connectUTXO.args[0][2].should.equal(height);
        worker._connectUTXO.args[0][3].should.equal(transaction);
        worker._connectUTXO.args[0][4].should.equal(transaction.inputs[0]);
        worker._connectUTXO.args[0][5].should.equal(spentOutputs);

        worker._connectUTXO.args[1][0].should.equal(txn);
        worker._connectUTXO.args[1][1].should.equal(walletId);
        worker._connectUTXO.args[1][2].should.equal(height);
        worker._connectUTXO.args[1][3].should.equal(transaction);
        worker._connectUTXO.args[1][4].should.equal(transaction.outputs[0]);
        worker._connectUTXO.args[1][5].should.equal(spentOutputs);

        models.Wallet.fromBuffer.callCount.should.equal(1);
        models.Wallet.fromBuffer.args[0][0].should.equal(walletId);
        models.Wallet.fromBuffer.args[0][1].should.equal(binaryBuf);

        wallet.addBalance.callCount.should.equal(2);
        wallet.addBalance.args[0][0].should.equal(-100000000);
        wallet.addBalance.args[1][0].should.equal(100000000);
        done();
      });
    });
    it('will check against false postitives', function(done) {
      var worker = new WriterWorker(options);
      var txn = {
        getBinary: sinon.stub().returns(null),
        putBinary: sinon.stub()
      };
      var transaction = {
        inputs: [
          {
            satoshis: -100000000,
            index: 10,
            address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
          }
        ],
        outputs: [],
      };
      var height = 10;
      var spentOutputs = {};
      var wallets = {};

      sandbox.stub(models.WalletAddressMap, 'getKey').returns('address map key');
      worker.db = {
        addressesMap: {}
      };
      worker._connectTransaction(txn, wallets, height, transaction, spentOutputs, function() {
        txn.getBinary.callCount.should.equal(1);
        txn.putBinary.callCount.should.equal(0);
        done();
      });
    });
  });
  describe('#_connectBlockCommit', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will batch and update wallet data references', function(done) {
      var walletBlock = {
        blockHash: '0000000000253b76babed6f36b68b79a0c232f89e6756bd7a848c63b83ca53a4',
        getKey: sinon.stub().returns('test key'),
        getValue: sinon.stub().returns('test value'),
        addressFilter: BloomFilter.create(100, 0.01)
      };
      var block = {
        hash: '0000000000253b76babed6f36b68b79a0c232f89e6756bd7a848c63b83ca53a4'
      };
      var txn = {
        putBinary: sinon.stub(),
        commit: sinon.stub()
      };
      var spentOutputs = {};

      var worker = new WriterWorker(options);
      var clone = sinon.stub().returns(walletBlock);
      worker.walletBlock = {
        clone: clone
      };
      var wallet = {
        getKey: sinon.stub().returns('wallet getKey'),
        getValue: sinon.stub().returns('wallet getValue')
      };
      var wallets = {
        walletkey: wallet
      };
      worker.db = {
        env: {
          sync: sinon.stub().callsArg(0)
        },
        blocks: {},
        wallets: {}
      };
      sandbox.stub(console, 'info');
      worker._connectBlockCommit(txn, wallets, block, spentOutputs, function(err) {
        if (err) {
          return done(err);
        }
        clone.callCount.should.equal(1);
        txn.putBinary.callCount.should.equal(2);
        txn.putBinary.args[0][0].should.equal(worker.db.blocks);
        txn.putBinary.args[0][1].should.equal('test key');
        txn.putBinary.args[0][2].should.equal('test value');

        txn.putBinary.args[1][0].should.equal(worker.db.wallets);
        txn.putBinary.args[1][1].should.equal('wallet getKey');
        txn.putBinary.args[1][2].should.equal('wallet getValue');

        txn.commit.callCount.should.equal(1);

        worker.db.env.sync.callCount.should.equal(1);
        worker.walletBlock.should.equal(walletBlock);
        worker.blockFilter.addressFilter.should.equal(walletBlock.addressFilter);
        worker.blockFilter.network.should.equal(worker.network);
        console.info.callCount.should.equal(1);
        done();
      });
    });
    it('will err from db sync', function(done) {
      var walletBlock = {
        blockHash: '0000000000253b76babed6f36b68b79a0c232f89e6756bd7a848c63b83ca53a4',
        getKey: sinon.stub().returns('test key'),
        getValue: sinon.stub().returns('test value'),
        addressFilter: BloomFilter.create(100, 0.01)
      };
      var block = {
        hash: '0000000000253b76babed6f36b68b79a0c232f89e6756bd7a848c63b83ca53a4'
      };
      var txn = {
        putBinary: sinon.stub(),
        commit: sinon.stub()
      };
      var spentOutputs = {};

      var worker = new WriterWorker(options);
      var clone = sinon.stub().returns(walletBlock);
      worker.walletBlock = {
        clone: clone
      };
      var wallet = {
        getKey: sinon.stub().returns('wallet getKey'),
        getValue: sinon.stub().returns('wallet getValue')
      };
      var wallets = {
        walletkey: wallet
      };
      worker.db = {
        env: {
          sync: sinon.stub().callsArgWith(0, new Error('test error'))
        },
        blocks: {},
        wallets: {}
      };

      worker._connectBlockCommit(txn, wallets, block, spentOutputs, function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        err.message.should.equal('test error');
        done();
      });
    });
  });
  describe('#_connectBlock', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will parse addresses in block belonging to wallet', function(done) {
      var block = {
        height: 10,
        hash: '0000000000253b76babed6f36b68b79a0c232f89e6756bd7a848c63b83ca53a4'
      };
      var transactions = {
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a'
      };
      var worker = new WriterWorker(options);
      worker.blockFilter = {
        filterDeltas: sinon.stub().returns(transactions)
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub()
        }
      };
      sandbox.stub(worker, '_connectTransaction').callsArg(5);
      sandbox.stub(worker, '_connectBlockCommit').callsArg(4);
      worker._connectBlock(block, function() {
        worker.blockFilter.filterDeltas.callCount.should.equal(1);
        worker.blockFilter.filterDeltas.args[0][0].should.deep.equal(block);
        worker.db.env.beginTxn.callCount.should.equal(1);
        worker._connectTransaction.callCount.should.equal(1);
        worker._connectBlockCommit.callCount.should.equal(1);
        done();
      });
    });
    it('will error trying to parse a block', function(done) {
      var block = {
        height: 10,
        hash: '0000000000253b76babed6f36b68b79a0c232f89e6756bd7a848c63b83ca53a4'
      };
      var txn = {
        abort: sinon.stub()
      };
      var transactions = {
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a'
      };
      var worker = new WriterWorker(options);
      worker.blockFilter = {
        filterDeltas: sinon.stub().returns(transactions)
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn)
        }
      };
      sandbox.stub(worker, '_connectTransaction').callsArgWith(5, new Error('test error message'));
      sandbox.stub(worker, '_connectBlockCommit').callsArg(4);
      worker._connectBlock(block, function(err) {
        txn.abort.callCount.should.equal(1);
        should.exist(err);
        err.should.be.instanceOf(Error);
        err.message.should.equal('test error message');
        done();
      });
    });
  });
  describe('#_disconnectTransaction', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('connect transaction from list of inputs and outputs', function(done) {
      var worker = new WriterWorker(options);
      var walletId = new Buffer('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', 'hex');
      var binaryBuf = new Buffer('some value' , 'hex');
      var txn = {
        getBinary: sinon.stub().returns(binaryBuf),
        del: sinon.stub()
      };
      var transaction = {
        inputs: [
          {
            satoshis: -100000000,
            index: 10,
            address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
          }
        ],
        outputs: [
          {
            satoshis: 100000000,
            index: 10,
            address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
          }
        ],
        index: 100,
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a'
      };
      var txid = {
        getKey: sinon.stub().returns('90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a'),
        getValue: sinon.stub().returns('some value')
      };
      var height = 10;
      var spentOutputs = {};
      var wallets = {};
      var wallet = {
        addBalance: sinon.stub()
      };
      sandbox.stub(models.WalletAddressMap, 'getKey').returns('address map key');
      sandbox.stub(utils, 'splitBuffer').returns([walletId]);
      sandbox.stub(models.WalletTxid, 'create').returns(txid);
      sandbox.stub(models.Wallet, 'fromBuffer').returns(wallet);
      worker.db = {
        addressesMap: {},
        wallets: {},
        txids: {}
      };
      worker._disconnectUTXO = sinon.stub();

      worker._disconnectTransaction(txn, wallets, height, transaction, spentOutputs, function() {

        models.WalletAddressMap.getKey.callCount.should.equal(2);
        models.WalletAddressMap.getKey.args[0][0].should.equal(transaction.inputs[0].address);
        models.WalletAddressMap.getKey.args[0][1].should.equal('hex');
        models.WalletAddressMap.getKey.args[0][2].name.should.equal(options.network);

        models.WalletAddressMap.getKey.args[1][0].should.equal(transaction.outputs[0].address);
        models.WalletAddressMap.getKey.args[1][1].should.equal('hex');
        models.WalletAddressMap.getKey.args[1][2].name.should.equal(options.network);

        txn.getBinary.callCount.should.equal(3);
        txn.getBinary.args[0][0].should.deep.equal(worker.db.addressesMap);
        txn.getBinary.args[0][1].should.equal('address map key');

        txn.getBinary.args[1][0].should.deep.equal(worker.db.wallets);
        txn.getBinary.args[1][1].should.equal(walletId.toString('hex'));

        txn.getBinary.args[2][0].should.deep.equal(worker.db.addressesMap);
        txn.getBinary.args[2][1].should.equal('address map key');

        models.WalletTxid.create.callCount.should.equal(2);
        models.WalletTxid.create.args[0][0].should.equal(walletId);
        models.WalletTxid.create.args[0][1].should.equal(height);
        models.WalletTxid.create.args[0][2].should.equal(transaction.index);
        models.WalletTxid.create.args[0][3].should.equal(transaction.txid);

        models.WalletTxid.create.args[1][0].should.equal(walletId);
        models.WalletTxid.create.args[1][1].should.equal(height);
        models.WalletTxid.create.args[1][2].should.equal(transaction.index);
        models.WalletTxid.create.args[1][3].should.equal(transaction.txid);

        txn.del.callCount.should.equal(2);
        txn.del.args[0][0].should.equal(worker.db.txids);
        txn.del.args[0][1].should.equal('90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a');

        worker._disconnectUTXO.callCount.should.equal(2);
        worker._disconnectUTXO.args[0][0].should.equal(txn);
        worker._disconnectUTXO.args[0][1].should.equal(walletId);
        worker._disconnectUTXO.args[0][2].should.equal(height);
        worker._disconnectUTXO.args[0][3].should.equal(transaction);
        worker._disconnectUTXO.args[0][4].should.equal(transaction.inputs[0]);
        worker._disconnectUTXO.args[0][5].should.equal(spentOutputs);

        worker._disconnectUTXO.args[1][0].should.equal(txn);
        worker._disconnectUTXO.args[1][1].should.equal(walletId);
        worker._disconnectUTXO.args[1][2].should.equal(height);
        worker._disconnectUTXO.args[1][3].should.equal(transaction);
        worker._disconnectUTXO.args[1][4].should.equal(transaction.outputs[0]);
        worker._disconnectUTXO.args[1][5].should.equal(spentOutputs);

        models.Wallet.fromBuffer.callCount.should.equal(1);
        models.Wallet.fromBuffer.args[0][0].should.equal(walletId);
        models.Wallet.fromBuffer.args[0][1].should.equal(binaryBuf);

        wallet.addBalance.callCount.should.equal(2);
        wallet.addBalance.args[0][0].should.equal(100000000);
        wallet.addBalance.args[1][0].should.equal(-100000000);
        done();
      });
    });
    it('will check against false postitives', function(done) {
      var worker = new WriterWorker(options);
      var txn = {
        getBinary: sinon.stub().returns(null),
        putBinary: sinon.stub()
      };
      var transaction = {
        inputs: [
          {
            satoshis: -100000000,
            index: 10,
            address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
          }
        ],
        outputs: [],
      };
      var height = 10;
      var spentOutputs = {};
      var wallets = {};

      sandbox.stub(models.WalletAddressMap, 'getKey').returns('address map key');
      worker.db = {
        addressesMap: {}
      };
      worker._disconnectTransaction(txn, wallets, height, transaction, spentOutputs, function() {
        txn.getBinary.callCount.should.equal(1);
        txn.putBinary.callCount.should.equal(0);
        done();
      });
    });
  });
  describe('#_disconnectBlockCommit', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will batch and update wallet data references', function(done) {
      var walletBlock = {
        blockHash: '0000000000253b76babed6f36b68b79a0c232f89e6756bd7a848c63b83ca53a4',
        getKey: sinon.stub().returns('test key'),
        getValue: sinon.stub().returns('test value'),
        addressFilter: BloomFilter.create(100, 0.01),
        height: 10
      };
      var prevWalletBlock = {
        blockHash: '0000000000253b76babed6f36b68b79a0c232f89e6756bd7a848c63b83ca53a5',
        getKey: sinon.stub().returns('test key'),
        getValue: sinon.stub().returns('test value'),
        addressFilter: BloomFilter.create(100, 0.01),
        height: 9
      };
      var txn = {
        putBinary: sinon.stub(),
        getBinary: sinon.stub().returns('something'),
        commit: sinon.stub()
      };

      var worker = new WriterWorker(options);
      var clone = sinon.stub().returns(walletBlock);
      worker.walletBlock = {
        clone: clone
      };
      var wallet = {
        getKey: sinon.stub().returns('wallet getKey'),
        getValue: sinon.stub().returns('wallet getValue')
      };
      var wallets = {
        walletkey: wallet
      };
      worker.db = {
        env: {
          sync: sinon.stub().callsArg(0)
        },
        blocks: {},
        wallets: {}
      };
      sandbox.stub(models.WalletBlock, 'fromBuffer').returns(prevWalletBlock);
      sandbox.stub(console, 'info');
      worker._disconnectBlockCommit(txn, wallets, walletBlock, function(err) {
        if (err) {
          return done(err);
        }
        txn.putBinary.callCount.should.equal(1);

        txn.putBinary.args[0][0].should.equal(worker.db.wallets);
        txn.putBinary.args[0][1].should.equal('wallet getKey');
        txn.putBinary.args[0][2].should.equal('wallet getValue');

        txn.commit.callCount.should.equal(1);

        worker.db.env.sync.callCount.should.equal(1);
        worker.walletBlock.should.equal(prevWalletBlock);
        worker.blockFilter.addressFilter.should.equal(prevWalletBlock.addressFilter);
        worker.blockFilter.network.should.equal(worker.network);
        console.info.callCount.should.equal(1);
        done();
      });
    });
    it('will err from db sync', function(done) {
      var walletBlock = {
        blockHash: '0000000000253b76babed6f36b68b79a0c232f89e6756bd7a848c63b83ca53a4',
        getKey: sinon.stub().returns('test key'),
        getValue: sinon.stub().returns('test value'),
        addressFilter: BloomFilter.create(100, 0.01)
      };
      var prevWalletBlock = {
        blockHash: '0000000000253b76babed6f36b68b79a0c232f89e6756bd7a848c63b83ca53a5',
        getKey: sinon.stub().returns('test key'),
        getValue: sinon.stub().returns('test value'),
        addressFilter: BloomFilter.create(100, 0.01),
        height: 9
      };
      var block = {
        hash: '0000000000253b76babed6f36b68b79a0c232f89e6756bd7a848c63b83ca53a4'
      };
      var txn = {
        putBinary: sinon.stub(),
        getBinary: sinon.stub().returns('something'),
        commit: sinon.stub()
      };

      var worker = new WriterWorker(options);
      var clone = sinon.stub().returns(walletBlock);
      worker.walletBlock = {
        clone: clone
      };
      var wallet = {
        getKey: sinon.stub().returns('wallet getKey'),
        getValue: sinon.stub().returns('wallet getValue')
      };
      var wallets = {
        walletkey: wallet
      };
      worker.db = {
        env: {
          sync: sinon.stub().callsArgWith(0, new Error('test error'))
        },
        blocks: {},
        wallets: {}
      };
      sandbox.stub(models.WalletBlock, 'fromBuffer').returns(prevWalletBlock);
      worker._disconnectBlockCommit(txn, wallets, block, function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        err.message.should.equal('test error');
        done();
      });
    });
  });
  describe('#_disconnectTip', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will disconnect tip', function(done) {
      var txn = {
        abort: sinon.stub(),
        getBinary: sinon.stub().returns('something')
      };
      var worker = new WriterWorker(options);
      var deltas = ['first'];
      var wb = {
        deltas: deltas
      };
      worker.walletBlock = {
        clone: sinon.stub().returns(wb)
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn)
        }
      };
      sandbox.stub(worker, '_disconnectTransaction').callsArg(5);
      sandbox.stub(worker, '_disconnectBlockCommit').callsArg(3);
      worker._disconnectTip(function() {
        worker.db.env.beginTxn.callCount.should.equal(1);
        worker._disconnectTransaction.callCount.should.equal(1);
        worker._disconnectBlockCommit.callCount.should.equal(1);
        done();
      });
    });
    it('will error trying to parse a block', function(done) {
      var txn = {
        abort: sinon.stub()
      };
      var transactions = {
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a'
      };
      var worker = new WriterWorker(options);
      var deltas = ['first'];
      var wb = {
        deltas: deltas
      };

      worker.walletBlock = {
        clone: sinon.stub().returns(wb)
      };

      worker.blockFilter = {
        filterDeltas: sinon.stub().returns(transactions)
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn)
        }
      };
      sandbox.stub(worker, '_disconnectTransaction').callsArgWith(5, new Error('test error message'));
      sandbox.stub(worker, '_disconnectBlockCommit').callsArg(3);
      worker._disconnectTip(function(err) {
        txn.abort.callCount.should.equal(1);
        should.exist(err);
        err.should.be.instanceOf(Error);
        err.message.should.equal('test error message');
        done();
      });
    });
  });
  describe('#_maybeGetBlockHash', function() {
    it('will not get block hash with an address', function(done) {
      var worker = new WriterWorker(options);
      worker._maybeGetBlockHash('2N2JD6wb56AfK4tfmM6PwdVmoYk2dCKf4Br', function(err, hash) {
        if (err) {
          return done(err);
        }
        hash.should.equal('2N2JD6wb56AfK4tfmM6PwdVmoYk2dCKf4Br');
        done();
      });
    });
    it('will not get block hash with non zero-nine numeric string', function(done) {
      var worker = new WriterWorker(options);
      worker._maybeGetBlockHash('109a', function(err, hash) {
        if (err) {
          return done(err);
        }
        hash.should.equal('109a');
        done();
      });
    });
    it('will get the block hash if argument is a number', function(done) {
      var worker = new WriterWorker(options);
      var getBlockHash = sinon.stub().callsArgWith(1, null, {
        result: 'blockhash'
      });
      var client = {
        getBlockHash: getBlockHash
      };
      worker._tryAllClients = function(fn, callback) {
        fn(client, callback);
      };
      worker._maybeGetBlockHash(10, function(err, hash) {
        if (err) {
          return done(err);
        }
        hash.should.equal('blockhash');
        getBlockHash.callCount.should.equal(1);
        done();
      });
    });
    it('will get the block hash if argument is a number (as string)', function(done) {
      var worker = new WriterWorker(options);
      var getBlockHash = sinon.stub().callsArgWith(1, null, {
        result: 'blockhash'
      });
      var client = {
        getBlockHash: getBlockHash
      };
      worker._tryAllClients = function(fn, callback) {
        fn(client, callback);
      };
      worker._maybeGetBlockHash('10', function(err, hash) {
        if (err) {
          return done(err);
        }
        hash.should.equal('blockhash');
        getBlockHash.callCount.should.equal(1);
        done();
      });
    });
    it('will give error from getBlockHash', function(done) {
      var worker = new WriterWorker(options);
      var getBlockHash = sinon.stub().callsArgWith(1, new Error('error message'));
      var client = {
        getBlockHash: getBlockHash
      };
      worker._tryAllClients = function(fn, callback) {
        fn(client, callback);
      };
      worker._maybeGetBlockHash(10, function(err) {
        getBlockHash.callCount.should.equal(1);
        err.should.be.instanceOf(Error);
        err.message.should.equal('error message');
        done();
      });
    });
  });
  describe('#_getBlockDeltas', function() {
    it('will error from getBlockDeltas', function(done) {
      var worker = new WriterWorker(options);
      worker._maybeGetBlockHash = sinon.stub().callsArgWith(1, null, 'block hash');
      var getBlockDeltas = sinon.stub().callsArgWith(1, new Error('error message'));
      var client = {
        getBlockDeltas: getBlockDeltas
      };
      worker._tryAllClients = function(fn, callback) {
        fn(client, callback);
      };
      worker._getBlockDeltas('something', function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        err.message.should.equal('error message');
        done();
      });
    });
    it('will return deltas', function(done) {
      var worker = new WriterWorker(options);
      worker._maybeGetBlockHash = sinon.stub().callsArgWith(1, null, 'block hash');
      var getBlockDeltas = sinon.stub().callsArgWith(1, null, {result: 'deltas'});
      var client = {
        getBlockDeltas: getBlockDeltas
      };
      worker._tryAllClients = function(fn, callback) {
        fn(client, callback);
      };
      worker._getBlockDeltas('something', function(err, deltas) {
        if (err) {
          return done(err);
        }
        deltas.should.equal('deltas');
        done();
      });
    });
    it('will error from maybeGetBlockHash', function(done) {
      var worker = new WriterWorker(options);
      worker._maybeGetBlockHash = sinon.stub().callsArgWith(1, new Error('error message'));
      worker._getBlockDeltas('something', function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        err.message.should.equal('error message');
        done();
      });
    });
  });
  describe('#_updateTip', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will get raw block or the next block height', function(done) {
      var worker = new WriterWorker(options);
      worker.walletBlock = {
        blockHash: new Buffer('000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943', 'hex')
      };
      worker._connectBlock = sinon.stub().callsArg(1);
      var blockDeltas = {
        previousblockhash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'
      };
      worker._getBlockDeltas = sinon.stub().callsArgWith(1, null, blockDeltas);
      worker._updateTip(0, function(err) {
        if (err) {
          return done(err);
        }
        worker._connectBlock.callCount.should.equal(1);
        worker._getBlockDeltas.args[0][0].should.equal(1);
        worker._connectBlock.args[0][0].should.equal(blockDeltas);
        done();
      });
    });
    it('will handle error from getting block', function(done) {
      var worker = new WriterWorker(options);
      worker._getBlockDeltas = sinon.stub().callsArgWith(1, new Error('error message'));
      worker._updateTip(100, function(err) {
        err.should.be.instanceOf(Error);
        err.message.should.equal('error message');
        done();
      });
    });
    it('will handle error while connecting block', function(done) {
      var worker = new WriterWorker(options);
      worker.walletBlock = {
        blockHash: new Buffer('000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943', 'hex')
      };
      worker._connectBlock = sinon.stub().callsArgWith(1, new Error('test'));
      var blockDeltas = {
        previousblockhash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'
      };
      worker._getBlockDeltas = sinon.stub().callsArgWith(1, null, blockDeltas);
      worker._updateTip(0, function(err) {
        err.should.be.instanceOf(Error);
        err.message.should.equal('test');
        done();
      });
    });
    it('will disconnect if block does not continue chain', function(done) {
      var worker = new WriterWorker(options);
      worker.walletBlock = {
        blockHash: new Buffer('000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943', 'hex')
      };
      worker._disconnectTip = sinon.stub().callsArg(0);
      var blockDeltas = {
        previousblockhash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4945'
      };
      worker._getBlockDeltas = sinon.stub().callsArgWith(1, null, blockDeltas);
      sandbox.stub(console, 'warn');
      worker._updateTip(0, function(err) {
        if (err) {
          return done(err);
        }
        worker._disconnectTip.callCount.should.equal(1);
        worker._getBlockDeltas.args[0][0].should.equal(1);
        console.warn.callCount.should.equal(2);
        done();
      });
    });
    it('error from disconnect tip', function(done) {
      var worker = new WriterWorker(options);
      worker.walletBlock = {
        blockHash: new Buffer('000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943', 'hex')
      };
      worker._disconnectTip = sinon.stub().callsArgWith(0, new Error('test'));
      var blockDeltas = {
        previousblockhash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4945'
      };
      worker._getBlockDeltas = sinon.stub().callsArgWith(1, null, blockDeltas);
      sandbox.stub(console, 'warn');
      worker._updateTip(0, function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        err.message.should.equal('test');
        console.warn.callCount.should.equal(1);
        done();
      });
    });
  });
  describe.skip('#_addAddressesToWallet', function() {
    it('', function() {
    });
    it('will handle error from client query', function(done) {
      var node = {
        network: 'livenet'
      };
      var wallet = new Wallet({node: node});
      wallet.bitcoind = {
        client: {
          getAddressDeltas: sinon.stub().callsArgWith(1, {code: -1, message: 'test'})
        }
      };
      var walletTxids = {
        insert: sinon.stub()
      };
      var walletData = {
        addressFilter: {
          insert: sinon.stub()
        },
        balance: 0,
        height: 100
      };
      var keyData = {
        address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
      };
      wallet._addKeyToWallet(walletTxids, walletData, keyData, function(err) {
        err.should.be.instanceOf(Error);
        done();
      });
    });
    it('will insert txids, update bloom filter and add to balance', function(done) {
      var deltas = [{
        satoshis: 50000000,
        height: 198,
        blockindex: 12,
        txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a'
      }];
      var node = {
        network: 'livenet'
      };
      var wallet = new Wallet({node: node});
      var txidsDbi = {};
      wallet.db = {
        txids: txidsDbi
      };
      wallet.bitcoind = {
        client: {
          getAddressDeltas: sinon.stub().callsArgWith(1, null, {
            result: deltas
          })
        }
      };
      var walletData = {
        addressFilter: {
          insert: sinon.stub()
        },
        balance: 50000000,
        height: 200
      };
      var keyData = {
        address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'
      };
      var txn = {
        putBinary: sinon.stub()
      };
      wallet._addKeyToWallet(txn, walletData, keyData, function(err) {
        if (err) {
          return done(err);
        }
        var getAddressDeltas = wallet.bitcoind.client.getAddressDeltas;
        getAddressDeltas.callCount.should.equal(1);
        var query = getAddressDeltas.args[0][0];
        query.should.deep.equal({addresses: ['16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'], start: 1, end: 200});
        txn.putBinary.callCount.should.equal(1);
        txn.putBinary.args[0][0].should.equal(txidsDbi);
        txn.putBinary.args[0][1].should.equal('000000c60000000c');
        txn.putBinary.args[0][2].should.deep.equal(
          new Buffer('90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a', 'hex')
        );
        walletData.addressFilter.insert.callCount.should.equal(1);
        var hashBuffer = walletData.addressFilter.insert.args[0][0].toString('hex');
        hashBuffer.should.equal('3c3fa3d4adcaf8f52d5b1843975e122548269937');
        walletData.balance.should.equal(100000000);
        done();
      });
    });
  });
  describe('#_commitWalletAddresses', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will send expected operations to batch command', function(done) {
      var walletId = '7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d';
      var worker = new WriterWorker(options);
      var txn = {
        getBinary: sinon.stub().returns('txn getBinary'),
        putBinary: sinon.stub(),
        commit: sinon.stub()
      };
      var walletDbi = {};
      var keysDbi = {};
      worker.db = {
        wallet: walletDbi,
        keys: keysDbi,
        env: {
          sync: sinon.stub().callsArg(0)
        },
        addresses: {},
        addressesMap: {},
        wallets: {},
        blocks: {}
      };
      var walletBlock = {
        getKey: sinon.stub().returns('walletBlock getKey'),
        getValue: sinon.stub().returns('walletBlock getValue'),
        addressFilter: BloomFilter.create(100, 0.01)
      };
      var wallet = {
        getKey: sinon.stub().returns('wallet getKey'),
        getValue: sinon.stub().returns('wallet getValue')
      };
      var newAddresses = [
        {
          getKey: sinon.stub().returns('walletAddress getKey'),
          getValue: sinon.stub().returns('walletAddress getValue')
        }
      ];
      var addressMap = {
        insert: sinon.stub(),
        getKey: sinon.stub().returns('addressMap getKey'),
        getValue: sinon.stub().returns('addressMap getValue')
      };
      sandbox.stub(models.WalletAddressMap, 'getKey').returns('test key');
      sandbox.stub(models.WalletAddressMap, 'fromBuffer').returns(addressMap);
      sandbox.stub(console, 'info');
      worker._commitWalletAddresses(txn, walletBlock, walletId, wallet, newAddresses, function(err) {
        if (err) {
          return done(err);
        }

        console.info.callCount.should.equal(1);
        txn.putBinary.callCount.should.equal(4);
        txn.putBinary.args[0][0].should.equal(worker.db.addresses);
        txn.putBinary.args[0][1].should.equal('walletAddress getKey');
        txn.putBinary.args[0][2].should.equal('walletAddress getValue');

        txn.putBinary.args[1][0].should.equal(worker.db.addressesMap);
        txn.putBinary.args[1][1].should.equal('addressMap getKey');
        txn.putBinary.args[1][2].should.equal('addressMap getValue');

        txn.putBinary.args[2][0].should.equal(worker.db.wallets);
        txn.putBinary.args[2][1].should.equal('wallet getKey');
        txn.putBinary.args[2][2].should.equal('wallet getValue');

        txn.putBinary.args[3][0].should.equal(worker.db.blocks);
        txn.putBinary.args[3][1].should.equal('walletBlock getKey');
        txn.putBinary.args[3][2].should.equal('walletBlock getValue');

        txn.getBinary.callCount.should.equal(1);
        txn.getBinary.args[0][0].should.equal(worker.db.addressesMap);
        txn.getBinary.args[0][1].should.equal('test key');

        txn.commit.callCount.should.equal(1);
        done();
      });
    });
    it.skip('will handle error from batch and leave wallet references unchanged', function(done) {
      var worker = new WriterWorker(options);
      worker.walletTxids = null;
      worker.walletData = null;
      var walletDbi = {};
      var keysDbi = {};
      worker.db = {
        wallet: walletDbi,
        keys: keysDbi,
        env: {
          sync: sinon.stub().callsArgWith(0, new Error('test'))
        }
      };
      var walletData = {
        toBuffer: sinon.stub()
      };
      var keyData = {
        getKey: sinon.stub().returns(new Buffer('03', 'hex')),
        getValue: sinon.stub()
      };
      var txn = {
        putBinary: sinon.stub(),
        commit: sinon.stub()
      };
      worker._commitWalletKey(txn, walletData, keyData, function(err) {
        err.should.be.instanceOf(Error);
        err.message.should.equal('test');
        should.equal(worker.walletData, null);
        done();
      });
    });
    it.skip('will update wallet references with updated data', function(done) {
      var worker = new WriterWorker(options);
      var walletDbi = {};
      var keysDbi = {};
      worker.db = {
        wallet: walletDbi,
        keys: keysDbi,
        env: {
          sync: sinon.stub().callsArg(0)
        }
      };
      var walletData = {
        toBuffer: sinon.stub()
      };
      var keyData = {
        getKey: sinon.stub().returns(new Buffer('03', 'hex')),
        getValue: sinon.stub()
      };
      var txn = {
        putBinary: sinon.stub(),
        commit: sinon.stub()
      };
      worker._commitWalletKey(txn, walletData, keyData, function(err) {
        if (err) {
          return done(err);
        }
        worker.walletData.should.equal(walletData);
        done();
      });
    });
  });
  describe.skip('#_connectBlockAddressDeltas', function() {
    var deltaData = {
      blockHeight: 10,
      address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r',
      deltas: [
        {
          blockIndex: 2,
          txid: 'd51a988ab4ed0cb80cdf228a1e657857708a6205c7037493010144441d60c676'
        }
      ],
    };
    it('will get database key for address', function(done) {
      var wallet = new Wallet({node: testNode});
      var txidsDbi = {};
      wallet.db = {
        txids: txidsDbi
      };
      var txn = {
        getBinary: sinon.stub().returns(true),
        putBinary: sinon.stub()
      };
      var walletData = {};
      wallet._connectBlockAddressDeltas(txn, walletData, deltaData, function(err) {
        if (err) {
          return done(err);
        }
        txn.putBinary.callCount.should.equal(1);
        txn.putBinary.args[0][0].should.equal(txidsDbi);
        txn.putBinary.args[0][1].should.equal('0000000a00000002');
        txn.putBinary.args[0][2].should.be.instanceOf(Buffer);
        txn.putBinary.args[0][2].toString('hex').should.equal(deltaData.deltas[0].txid);
        done();
      });
    });
    it('will skip if address does not exist', function(done) {
      var wallet = new Wallet({node: testNode});
      var txidsDbi = {};
      wallet.db = {
        txids: txidsDbi
      };
      var txn = {
        getBinary: sinon.stub().returns(false),
        putBinary: sinon.stub()
      };
      var walletData = {};
      wallet._connectBlockAddressDeltas(txn, walletData, deltaData, function(err) {
        if (err) {
          return done(err);
        }
        txn.putBinary.callCount.should.equal(0);
        done();
      });
    });
    it('will update balance of walletData', function() {
    });
  });

  describe('#sync', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will bail out if already syncing', function(done) {
      var wallet = new WriterWorker(options);
      wallet._updateTip = sinon.stub();
      wallet.syncing = true;
      wallet.sync({
        bitcoinHeight: 101,
        bitcoinHash: 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177'
      }, function(err) {
        if (err) {
          return done(err);
        }
        wallet._updateTip.callCount.should.equal(0);
        done();
      });
    });
    it('will bail out if node is stopping', function(done) {
      var wallet = new WriterWorker(options);
      wallet._updateTip = sinon.stub();
      wallet.stopping = true;
      wallet.sync({
        bitcoinHeight: 101,
        bitcoinHash: 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177'
      }, function(err) {
        if (err) {
          return done(err);
        }
        wallet._updateTip.callCount.should.equal(0);
        done();
      });
    });
    it('will bail out if walletBlock is not available', function(done) {
      var wallet = new WriterWorker(options);
      wallet._updateTip = sinon.stub();
      wallet.walletBlock = null;
      wallet.sync({
        bitcoinHeight: 101,
        bitcoinHash: 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177'
      }, function(err) {
        if (err) {
          return done(err);
        }
        wallet._updateTip.callCount.should.equal(0);
        done();
      });
    });
    it('will update wallet height until it matches bitcoind height', function(done) {
      var wallet = new WriterWorker(options);
      wallet.walletBlock = {};
      wallet.walletBlock.height = 100;
      wallet.walletBlock.blockHash = 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177';
      wallet._updateTip = function(height, callback) {
        wallet.walletBlock.height += 1;
        setImmediate(callback);
      };
      sinon.spy(wallet, '_updateTip');
      sandbox.stub(console, 'info');
      wallet.sync({
        bitcoinHeight: 200,
        bitcoinHash: 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177'
      }, function() {
        wallet._updateTip.callCount.should.equal(100);
        wallet.walletBlock.height.should.equal(200);
        wallet.syncing.should.equal(false);
        console.info.callCount.should.equal(2);
        done();
      });
    });
    it('will bail out if node is stopping while syncing', function(done) {
      var wallet = new WriterWorker(options);
      wallet.stopping = false;
      wallet.walletBlock = {};
      wallet.walletBlock.height = 100;
      wallet.walletBlock.blockHash = 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177';

      wallet.bitcoind = {
        height: 200
      };
      wallet._updateTip = function(height, callback) {
        wallet.walletBlock.height += 1;
        wallet.stopping = true;
        setImmediate(callback);
      };
      sinon.spy(wallet, '_updateTip');
      sandbox.stub(console, 'info');
      wallet.sync({
        bitcoinHeight: 200,
        bitcoinHash: 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177'
      }, function() {
        wallet._updateTip.callCount.should.equal(1);
        wallet.walletBlock.height.should.equal(101);
        wallet.syncing.should.equal(false);
        console.info.callCount.should.equal(2);
        done();
      });
    });
    it('will emit error while syncing', function(done) {
      var wallet = new WriterWorker(options);
      wallet.stopping = false;
      wallet.walletBlock = {};
      wallet.walletBlock.height = 100;
      wallet.walletBlock.blockHash = 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177';

      wallet.bitcoind = {
        height: 200
      };
      wallet._updateTip = sinon.stub().callsArgWith(1, new Error('test'));
      sandbox.stub(console, 'error');
      sandbox.stub(console, 'info');
      wallet.sync({
        bitcoinHeight: 200,
        bitcoinHash: 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177'
      }, function(err) {
        err.should.be.instanceOf(Error);
        wallet.syncing.should.equal(false);
        console.error.callCount.should.equal(1);
        console.info.callCount.should.equal(1);
        done();
      });
    });
  });
  describe('#_filterNewAddresses', function() {
    it('it will continue if key is not found', function(done) {
      var worker = new WriterWorker(options);
      worker.db = {
        addresses: {}
      };
      var txn = {
        getBinary: sinon.stub().returns('test getBinary')
      };
      var walletAddress = [
        {
          getKey: sinon.stub().returns('test getKey')
        }
      ];
      var ret = worker._filterNewAddresses(txn, walletAddress);
      txn.getBinary.callCount.should.equal(1);
      txn.getBinary.args[0][0].should.deep.equal(worker.db.addresses);
      txn.getBinary.args[0][1].should.equal('test getKey');
      ret.should.deep.equal([]);
      done();
    });
    it('it will continue if key is found', function(done) {
      var worker = new WriterWorker(options);
      worker.db = {
        addresses: {}
      };
      var txn = {
        getBinary: sinon.stub().returns(null)
      };
      var walletAddress = [
        {
          getKey: sinon.stub().returns('test getKey')
        }
      ];
      var ret = worker._filterNewAddresses(txn, walletAddress);
      walletAddress.should.deep.equal(ret);
      done();
    });
  });  
  describe('#_addUTXOSToWallet', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('adds UTXOs to wallet', function(done) {
      var worker = new WriterWorker(options);
      var response = {
        result: [
          {
            height: 10,
            address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r',
            txid: '90e262c7baaf4a5a8eb910d075e945d5a27f856f71a06ff8681128115a07441a',
            outputIndex: 50,
            satoshis: 100000000
          }
        ]
      };
      worker._clients[0] = {
        getAddressUtxos: sinon.stub().callsArgWith(1, null, response)
      };
      var newAddresses = [
        {
          address: 'first'
        }
      ];
      sandbox.stub(console, 'info');
      worker._addUTXO = sinon.stub();
      worker._addUTXOSToWallet({}, '', newAddresses, function(err) {
        if (err) {
          return done(err);
        }
        console.info.callCount.should.equal(1);
        worker._clients[0].getAddressUtxos.callCount.should.equal(1);
        worker._clients[0].getAddressUtxos.args[0][0].addresses[0].should.equal('first');
        worker._addUTXO.callCount.should.equal(1);
        worker._addUTXO.args[0][0].should.deep.equal({});
        worker._addUTXO.args[0][1].should.equal('');
        worker._addUTXO.args[0][2].height.should.equal(response.result[0].height);
        worker._addUTXO.args[0][2].address.should.equal(response.result[0].address);
        worker._addUTXO.args[0][2].txid.should.equal(response.result[0].txid);
        worker._addUTXO.args[0][2].satoshis.should.equal(response.result[0].satoshis);
        worker._addUTXO.args[0][2].index.should.equal(response.result[0].outputIndex);

        done();
      });
    });
    it('returns error from getAddressUtxos', function(done) {
      var worker = new WriterWorker(options);
      worker._clients[0] = {
        getAddressUtxos: sinon.stub().callsArgWith(1, new Error('test'))
      };
      var newAddresses = [
        {
          address: 'first'
        }
      ];
      sandbox.stub(console, 'info');
      worker._addUTXO = sinon.stub();
      worker._addUTXOSToWallet({}, '', newAddresses, function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        err.message.should.equal('test');
        done();
      });
    });
  });
  describe('#importWalletAddresses', function() {
    var walletId = new Buffer('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', 'hex');
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will give error if wallet is currently syncing or importing another address', function(done) {
      var worker = new WriterWorker(options);
      worker.syncing = true;
      worker.importWalletAddresses({}, {}, function(err) {
        err.should.be.instanceOf(Error);
        done();
      });
    });
    it('will return wallet does not exist error when walletBlock is not present', function(done) {
      var worker = new WriterWorker(options);
      worker.db = {
        env: {
          beginTxn: sinon.stub()
        }
      };
      worker.importWalletAddresses(walletId, {address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'}, function(err) {
        err.should.be.instanceOf(Error);
        worker.syncing.should.equal(false);
        done();
      });
    });
    it('will set syncing until finished', function(done) {
      var worker = new WriterWorker(options);
      worker.walletBlock = {};
      worker.walletBlock.height = 100;
      worker.walletBlock.blockHash = 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177';
      worker.walletBlock = {
        clone: sinon.stub()
      };
      var txn = {
        getBinary: sinon.stub().returns(new Buffer('test buffer', 'utf8')),
        abort: sinon.stub()
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn)
        }
      };
      sandbox.stub(models.Wallet, 'fromBuffer').returns('test fromBuffer');
      sandbox.stub(models, 'WalletAddress').returns('something');
      worker._filterNewAddresses = sinon.stub().returns('new addresses');
      worker._addAddressesToWallet = sinon.stub().callsArg(5);
      worker._addUTXOSToWallet = sinon.stub().callsArg(3);
      worker._commitWalletAddresses = sinon.stub().callsArg(5);

      worker.importWalletAddresses(walletId, [{address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'}], function(err) {
        if (err) {
          return done(err);
        }
        worker.syncing.should.equal(false);
        done();
      });
    });
    it('will return wallet does not exist error when getBinary fails', function(done) {
      var worker = new WriterWorker(options);
      worker.walletBlock = {};
      worker.walletBlock.height = 100;
      worker.walletBlock.blockHash = 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177';
      worker.walletBlock = {
        clone: sinon.stub()
      };
      var txn = {
        getBinary: sinon.stub().returns(null),
        abort: sinon.stub()
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn)
        },
        wallets: {}
      };
      worker.importWalletAddresses(walletId, {address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'}, function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        worker.syncing.should.equal(false);
        txn.abort.callCount.should.equal(1);
        done();
      });
    });
    it('will error when addressesToWallet fails', function(done) {
      var worker = new WriterWorker(options);
      worker.walletBlock = {};
      worker.walletBlock.height = 100;
      worker.walletBlock.blockHash = 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177';
      worker.walletBlock = {
        clone: sinon.stub()
      };
      var txn = {
        getBinary: sinon.stub().returns(new Buffer('test buffer', 'utf8')),
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn)
        },
        wallets: {}
      };
      sandbox.stub(models.Wallet, 'fromBuffer').returns('test fromBuffer');
      sandbox.stub(models, 'WalletAddress').returns('something');
      worker._filterNewAddresses = sinon.stub().returns(['new addresses']);
      worker._addAddressesToWallet = sinon.stub().callsArgWith(5, new Error('test'));
      worker.importWalletAddresses(walletId, [{address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'}], function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        worker.syncing.should.equal(false);
        done();
      });
    });
    it('will error when addUTXOs fails', function(done) {
      var worker = new WriterWorker(options);
      worker.walletBlock = {};
      worker.walletBlock.height = 100;
      worker.walletBlock.blockHash = 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177';
      worker.walletBlock = {
        clone: sinon.stub()
      };
      var txn = {
        getBinary: sinon.stub().returns(new Buffer('test buffer', 'utf8')),
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn)
        },
        wallets: {}
      };
      sandbox.stub(models.Wallet, 'fromBuffer').returns('test fromBuffer');
      sandbox.stub(models, 'WalletAddress').returns('something');
      worker._filterNewAddresses = sinon.stub().returns(['new addresses']);
      worker._addAddressesToWallet = sinon.stub().callsArg(5);
      worker._addUTXOSToWallet = sinon.stub().callsArgWith(3, new Error('test'));
      worker.importWalletAddresses(walletId, [{address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'}], function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        worker.syncing.should.equal(false);
        done();
      });
    });
    it('will error when _commitWalletAddresses fails', function(done) {
      var worker = new WriterWorker(options);
      worker.walletBlock = {};
      worker.walletBlock.height = 100;
      worker.walletBlock.blockHash = 'c3f6790a1e612146c2f36ed0855c560b39e602be7c27b37007f946e9c2adf177';
      worker.walletBlock = {
        clone: sinon.stub()
      };
      var txn = {
        getBinary: sinon.stub().returns(new Buffer('test buffer', 'utf8')),
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn)
        },
        wallets: {}
      };
      sandbox.stub(models.Wallet, 'fromBuffer').returns('test fromBuffer');
      sandbox.stub(models, 'WalletAddress').returns('something');
      worker._filterNewAddresses = sinon.stub().returns(['new addresses']);
      worker._addAddressesToWallet = sinon.stub().callsArg(5);
      worker._addUTXOSToWallet = sinon.stub().callsArgWith(3);
      worker._commitWalletAddresses = sinon.stub().callsArgWith(5, new Error('test'));
      worker.importWalletAddresses(walletId, [{address: '16VZnHwRhwrExfeHFHGjwrgEMq8VcYPs9r'}], function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        worker.syncing.should.equal(false);
        done();
      });
    });
  });
  describe('#saveTransaction', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will save a transaction to db', function(done) {
      var worker = new WriterWorker(options);
      var walletId = '7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d';
      var txn = {
        putBinary: sinon.stub(),
        commit: sinon.stub()
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn),
          sync: sinon.stub().callsArg(0)
        },
        txs: {},
      };
      var walletTransaction = {
        getKey: sinon.stub().returns('test getKey'),
        getValue: sinon.stub().returns('test getValue')
      };
      sandbox.stub(models.WalletTransaction, 'create').returns(walletTransaction);
      worker.saveTransaction(walletId, 'test transaction', function(err) {
        if (err) {
          return done(err);
        }
        models.WalletTransaction.create.callCount.should.equal(1);
        models.WalletTransaction.create.args[0][0].should.equal(walletId);
        models.WalletTransaction.create.args[0][1].should.equal('test transaction');

        worker.db.env.beginTxn.callCount.should.equal(1);
        walletTransaction.getValue.callCount.should.equal(1);

        txn.putBinary.callCount.should.equal(1);
        txn.putBinary.args[0][0].should.equal(worker.db.txs);
        txn.putBinary.args[0][1].should.equal('test getKey');
        txn.putBinary.args[0][2].should.equal('test getValue');

        txn.commit.callCount.should.equal(1);
        worker.db.env.sync.callCount.should.equal(1);
        done();
      });
    });
    it('db sync returns error', function(done) {
      var worker = new WriterWorker(options);
      var walletId = '7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d';
      var txn = {
        putBinary: sinon.stub(),
        commit: sinon.stub()
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn),
          sync: sinon.stub().callsArgWith(0, new Error('test'))
        },
        txs: {},
      };
      var walletTransaction = {
        getKey: sinon.stub().returns('test getKey'),
        getValue: sinon.stub().returns('test getValue')
      };
      sandbox.stub(models.WalletTransaction, 'create').returns(walletTransaction);
      worker.saveTransaction(walletId, 'test transaction', function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        err.message.should.equal('test');

        models.WalletTransaction.create.callCount.should.equal(1);
        models.WalletTransaction.create.args[0][0].should.equal(walletId);
        models.WalletTransaction.create.args[0][1].should.equal('test transaction');

        worker.db.env.beginTxn.callCount.should.equal(1);
        walletTransaction.getValue.callCount.should.equal(1);

        txn.putBinary.callCount.should.equal(1);
        txn.putBinary.args[0][0].should.equal(worker.db.txs);
        txn.putBinary.args[0][1].should.equal('test getKey');
        txn.putBinary.args[0][2].should.equal('test getValue');

        txn.commit.callCount.should.equal(1);
        worker.db.env.sync.callCount.should.equal(1);
        done();
      });
    });
  });
  describe('#createWallet', function() {
    var sandbox = sinon.sandbox.create();
    afterEach(function() {
      sandbox.restore();
    });
    it('will create a new wallet by walletId', function(done) {
      var worker = new WriterWorker(options);
      var txn = {
        getBinary: sinon.stub().returns(null),
        putBinary: sinon.stub(),
        commit: sinon.stub()
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn),
          sync: sinon.stub().callsArg(0)
        },
        wallets: {},
        blocks: {}
      };
      var walletBlock = {
        getKey: sinon.stub().returns('test key'),
        getValue: sinon.stub().returns('test value')
      };
      worker._initWalletBlock = sinon.stub().returns(walletBlock);
      var wallet = {
        getKey: sinon.stub().returns('wallet getKey'),
        getValue: sinon.stub().returns('wallet getValue')
      };
      sandbox.stub(models.Wallet, 'create').returns(wallet);
      worker.createWallet('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', function(err) {
        if (err) {
          return done(err);
        }
        worker._initWalletBlock.callCount.should.equal(1);

        txn.putBinary.callCount.should.equal(2);
        txn.putBinary.args[0][0].should.deep.equal(worker.db.wallets);
        txn.putBinary.args[0][1].should.equal('test key');
        txn.putBinary.args[0][2].should.equal('test value');

        txn.putBinary.args[1][0].should.deep.equal(worker.db.wallets);
        txn.putBinary.args[1][1].should.equal('wallet getKey');
        txn.putBinary.args[1][2].should.equal('wallet getValue');

        txn.getBinary.callCount.should.equal(1);
        txn.getBinary.args[0][0].should.deep.equal(worker.db.wallets);
        txn.getBinary.args[0][1].should.equal('wallet getKey');

        txn.commit.callCount.should.equal(1);
        done();
      });
    });
    it('bail if wallet already exists', function(done) {
      var worker = new WriterWorker(options);
      var txn = {
        getBinary: sinon.stub().returns('txn getBinary'),
        putBinary: sinon.stub(),
        abort: sinon.stub()
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn),
          sync: sinon.stub().callsArg(0)
        },
        wallets: {},
        blocks: {}
      };
      var walletBlock = {
        getKey: sinon.stub().returns('test key'),
        getValue: sinon.stub().returns('test value')
      };
      worker._initWalletBlock = sinon.stub().returns(walletBlock);
      var wallet = {
        getKey: sinon.stub().returns('wallet getKey'),
        getValue: sinon.stub().returns('wallet getValue')
      };
      sandbox.stub(models.Wallet, 'create').returns(wallet);
      worker.createWallet('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', function(err) {
        if (err) {
          return done(err);
        }
        worker._initWalletBlock.callCount.should.equal(1);

        txn.putBinary.callCount.should.equal(1);
        txn.putBinary.args[0][0].should.deep.equal(worker.db.wallets);
        txn.putBinary.args[0][1].should.equal('test key');
        txn.putBinary.args[0][2].should.equal('test value');

        txn.getBinary.callCount.should.equal(1);
        txn.getBinary.args[0][0].should.deep.equal(worker.db.wallets);
        txn.getBinary.args[0][1].should.equal('wallet getKey');

        txn.abort.callCount.should.equal(1);
        done();
      });
    });
    it('db sync returns error', function(done) {
      var worker = new WriterWorker(options);
      var txn = {
        getBinary: sinon.stub().returns(null),
        putBinary: sinon.stub(),
        commit: sinon.stub()
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn),
          sync: sinon.stub().callsArgWith(0, new Error('test'))
        },
        wallets: {},
        blocks: {}
      };
      var walletBlock = {
        getKey: sinon.stub().returns('test key'),
        getValue: sinon.stub().returns('test value')
      };
      worker._initWalletBlock = sinon.stub().returns(walletBlock);
      var wallet = {
        getKey: sinon.stub().returns('wallet getKey'),
        getValue: sinon.stub().returns('wallet getValue')
      };
      sandbox.stub(models.Wallet, 'create').returns(wallet);
      worker.createWallet('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', function(err) {
        should.exist(err);
        err.should.be.instanceOf(Error);
        err.message.should.equal('test');
        done();
      });
    });
    it('will create a new wallet when initial block present', function(done) {
      var worker = new WriterWorker(options);
      var txn = {
        getBinary: sinon.stub().returns(null),
        putBinary: sinon.stub(),
        commit: sinon.stub()
      };
      worker.db = {
        env: {
          beginTxn: sinon.stub().returns(txn),
          sync: sinon.stub().callsArg(0)
        },
        wallets: {},
        blocks: {}
      };
      worker._initWalletBlock = sinon.stub().returns(null);
      var wallet = {
        getKey: sinon.stub().returns('wallet getKey'),
        getValue: sinon.stub().returns('wallet getValue')
      };
      sandbox.stub(models.Wallet, 'create').returns(wallet);
      worker.createWallet('7e5a548623edccd9e18c4e515ba5e7380307f28463b4b90ea863aa34efa22a6d', function(err) {
        if (err) {
          return done(err);
        }
        worker._initWalletBlock.callCount.should.equal(1);

        txn.putBinary.callCount.should.equal(1);
        txn.putBinary.args[0][0].should.deep.equal(worker.db.wallets);
        txn.putBinary.args[0][1].should.equal('wallet getKey');
        txn.putBinary.args[0][2].should.equal('wallet getValue');

        txn.getBinary.callCount.should.equal(1);
        txn.getBinary.args[0][0].should.deep.equal(worker.db.wallets);
        txn.getBinary.args[0][1].should.equal('wallet getKey');

        txn.commit.callCount.should.equal(1);
        done();
      });
    });
  });
});
