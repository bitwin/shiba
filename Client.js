var _           =  require('lodash');
var Events      =  require('events');
var util        =  require('util');
var microtime   =  require('microtime');
var SocketIO    =  require('socket.io-client');
var debug       =  require('debug')('shiba:client');
var debuggame   =  require('debug')('shiba:game');
var debuguser   =  require('debug')('shiba:user');
var debugchat   =  require('debug')('shiba:chat');
var debugtick   =  require('debug')('shiba:tick');

var Lib         =  require('./Lib');
var LinearModel =  require('./LinearModel');

module.exports = Client;

function Client(config) {
  _.extend(this, Events);

  /* User state. Possible values are
   *
   *  WATCHING
   *    During starting time, this means that the user has not yet
   *    placed a bet. During and after the game it signifies that the
   *    user is not playing / has not played in the current round.
   *
   *  PLACING
   *    Is set when the user placed a bet during the starting time in
   *    order to avoid placing multiple bets. By the time the message
   *    reaches the server the game may have already started. In that
   *    case we get a 'game_started' event and never receive a
   *    'player_bet' event for ourselves.
   *
   *  PLACED
   *    During starting time this means that the user has placed a bet
   *    and it was successfully confirmed by the server.
   *
   *  PLAYING
   *    During the playing phase this means that the user is playing
   *    in this round and has not yet cashed out.
   *
   *  CASHINGOUT
   *    User has requested the server to cashout but has not received
   *    a confirmation yet.
   *
   *  CASHEDOUT
   *    User has played and successfully cashed out.
   *
   *  CRASHED
   *    The user played in this round but didn't successfully cashout
   *    before the game crashed.
   */
  this.userState = null;

  /** This will always be the last server seed that we received. It is
   *  set on joining the game and on the game_crash event.
   */
  this.lastServerSeed = null;

  this.username  = null;
  this.balance   = null;
  this.game      = null;

  /** A linear regression model to estimate tick times. */
  this.tickModel = null;

  this.gameHistory = [];
  this.chatHistory = [];

  // Save configuration and stuff.
  this.config = config;
  var gameHost =
    config.gameserver_prot + '://' +
    config.gameserver_host + ':' +
    config.gameserver_port;

  debug("Setting up connection to", gameHost);
  this.socket = SocketIO(gameHost);
  this.socket.on('error', this.onError.bind(this));
  this.socket.on('connect', this.onConnect.bind(this));
  this.socket.on('disconnect', this.onDisconnect.bind(this));
  this.socket.on('game_starting', this.onGameStarting.bind(this));
  this.socket.on('game_started', this.onGameStarted.bind(this));
  this.socket.on('game_tick', this.onGameTick.bind(this));
  this.socket.on('game_crash', this.onGameCrash.bind(this));
  this.socket.on('player_bet', this.onPlayerBet.bind(this));
  this.socket.on('cashed_out', this.onCashedOut.bind(this));
  this.socket.on('msg', this.onMsg.bind(this));
}

util.inherits(Client, Events.EventEmitter);

Client.prototype.onError = function(err) {
  console.error('onError: ', err);
};

Client.prototype.onConnect = function(data) {
  debug("Connected.");

  var self = this;
  self.emit('connect');
  getOtt(this.config, function(ott) {

    debug("Received one time token: " + ott);
    debug("Joining the game");

    var info = ott ? { ott: "" + ott } : {};
    self.socket.emit('join', info, function(err, data) {
      if (err) return console.error('Error when joining the game...', err);
      self.onJoin(data);
    });
  });
};

Client.prototype.onDisconnect = function(data) {
  debug('Client disconnected |', data, '|', typeof data);
  this.emit('disconnect');
};

Client.prototype.onJoin = function(data) {
  /* Example 1:
       { "state" : "IN_PROGRESS",
         "player_info" : { "Steve" : {"bet":500000},
                           "Shiba" : {"bet":21600,"stopped_at":103}
                         },
         "game_id":1023470,
         "last_hash":"c7a6e51b81d78bc3f01996cf76cd64aea3cb5b7fcdea65d28f3d16c3f7622081",
         "max_win":183474675.81,
         "elapsed":3597,
         "created":"2015-01-23T22:44:06.093Z",
         "joined":[],
         "chat":[ {"time":"2015-01-23T21:59:08.405Z",
                   "type":"say",
                   "username":"Steve",
                   "role":"user",
                   "message":"Hi"},
                  {"time":"2015-01-23T22:04:46.586Z",
                   "type":"say",
                   "username":"Ryan",
                   "role":"admin",
                   "message":"Hi"
                  },
                  {"time":"2015-01-23T22:04:59.297Z",
                   "type":"say",
                   "username":"Shiba",
                   "role":"moderator",
                   "message":"*bark*"
                  }
                ]
         "table_history": [ {"game_id":1023469,
                             "game_crash":0,
                             "created":"2015-01-23T22:43:58.025Z",
                             "player_info": {"Steve": {"bet":500000},
                                             "Shiba":{"bet":188600}
                                            },
                             "hash":"c7a6e51b81d78bc3f01996cf76cd64aea3cb5b7fcdea65d28f3d16c3f7622081"
                            }
                          ],
         "username":Steve,
         "balance_satoshis":133700
       }

     Example 2:
       { "state":"STARTING",
         "player_info":{},
         "game_id":1024781,
         "last_hash":"f0081ce965e0d8614e2c042310db60d725d98dfd8b1934aec6d35de369bd4347",
         "max_win":112105971.33,
         "elapsed":-1434,
         "created":"2015-01-24T07:48:46.261Z",
         "joined":["Steve","Shiba"],
         "chat":[],
         "table_history": [],
         "username":null,
         "balance_satoshis":null
       }
  */

  var copy =
    { state:        data.state,
      game_id:      data.game_id,
      last_hash:    data.last_hash,
      elapsed:      data.elapsed,
      username:     data.username,
      balance:      data.balance_satoshis
    };

  debug('Resetting client state\n%s', JSON.stringify(copy, null, ' '));

  this.gameHistory    = data.table_history;
  this.lastServerSeed = data.last_hash;
  this.game =
    { id:              data.game_id,
      serverSeedHash:  data.last_hash,
      players:         data.player_info,
      state:           data.state,
      startTime:       new Date(data.created),
      microStartTime:  null,
      ticks:           [],
      // Valid after crashed
      crashpoint:      null,
      serverSeed:      null,
      forced:          null
    };

  for (var i = 0; i < data.joined.length; ++i) {
    this.game.players[data.joined[i]] = {};
  }

  if (data.state === 'IN_PROGRESS') {
    this.game.microStartTime = this.game.startTime * 1000;
    var tickInfo =
      { elapsed: data.elapsed,
        growth:  Lib.growthFunc(data.elapsed),
        micro:   microtime.now() - this.game.microStartTime
      };
    this.game.ticks.push(tickInfo);
    this.tickModel = new LinearModel();
    this.tickModel.add(0,0);
    this.tickModel.add(tickInfo.elapsed, tickInfo.micro);
  }

  var players = data.player_info;

  this.balance  = data.balance_satoshis;
  this.username = data.username;

  // Retrieve user state from player info
  if (!players[this.username])
    this.userState = 'WATCHING';
  else if (players[this.username].stopped_at)
    this.userState = 'CASHEDOUT';
  else if(data.state == 'ENDED')
    this.userState = 'CRASHED';
  else
    this.userState = 'PLAYING';

  this.emit('join', data);
};

Client.prototype.onGameStarting = function(data) {
  /* Example:
       { "game_id":1000020,
         "max_win":150000000,
         "time_till_start":5000
       }
  */

  debuggame('Game #%d starting', data.game_id);
  this.game =
    { id:              data.game_id,
      // The server seed hash is always the seed of the previous games.
      serverSeedHash:  this.lastServerSeed,
      players:         {},
      state:           'STARTING',
      startTime:       new Date(Date.now() + data.time_till_start),
      microStartTime:  microtime.now() + 1000 * data.time_till_start,
      ticks:           [],
      // Valid after crashed
      crashpoint:      null,
      serverSeed:      null,
      forced:          null
    };

  this.userState = 'WATCHING';

  // We additionally add the server seed hash here.
  data.server_seed_hash = this.game.serverSeedHash;
  this.emit('game_starting', data);
};

Client.prototype.onGameStarted = function(bets) {
  debuggame('Game #%d started', this.game.id);
  this.game.state          = 'IN_PROGRESS';
  this.game.startTime      = new Date();
  this.game.microStartTime = microtime.now();

  for (var username in bets) {
    if (this.username === username)
      this.balance -= bets[username];

    // TODO: simplify after server upgrade
    if (this.game.players.hasOwnProperty(username))
      this.game.players[username].bet = bets[username];
    else
      this.game.players[username] = { bet: bets[username] };
  };

  var tickInfo =
    { elapsed: 0,
      growth: 100,
      micro: 0
    };
  this.game.ticks.push(tickInfo);
  this.tickModel = new LinearModel();
  this.tickModel.add(0, 0);

  if (this.userState == 'PLACED') {
    debuguser('User state: PLACED -> PLAYING');
    this.userState = 'PLAYING';
  } else if (this.userState == 'PLACING') {
    debuguser('Bet failed.');
    debuguser('User state: PLACING -> WATCHING');
    this.userState = 'WATCHING';
  }

  this.emit('game_started', bets);
};

Client.prototype.onGameTick = function(data) {
  // TODO: Simplify after server upgrade
  var elapsed      = typeof data == 'object' ? data.elapsed : data;
  var at           = Lib.growthFunc(elapsed);
  var previousTick = this.getLastTick();
  var micro        = microtime.now();
  var tickInfo     = { elapsed: elapsed,
                       growth: at,
                       micro: micro - this.game.microStartTime
                     };
  this.game.ticks.push(tickInfo);
  this.tickModel.add(elapsed, tickInfo.micro);

  var diffElapsed = tickInfo.elapsed - previousTick.elapsed;
  var diffMicro   = tickInfo.micro - previousTick.micro;
  var next        = this.estimateNextTick();
  var line        = Lib.formatFactor(at);
  line = line + " elapsed " + elapsed;
  line = line + " 'ΔElapsed " + diffElapsed + "'";
  line = line + " 'ΔMicro " + diffMicro + "'";
  line = line + " next " + Lib.formatFactor(next.upper.growth);
  line = line + " " + next.lower.elapsed + ' < tick < ' + next.upper.elapsed;

  debugtick('Tick ' + line);
  this.emit('game_tick', tickInfo);
};

Client.prototype.onGameCrash = function(data) {

  /* Example:
       { "forced":false,
         "elapsed":0,
         "game_crash":0,
         "bonuses":{"Steve":42,
                    "Shiba":1337
                   },
         "hash":"20c8a18be0fb4d4529b661938350bfbea3ed822c4dc83e764a079efa14ec9af9"
       }
  */

  var crash = Lib.formatFactor(data.game_crash);
  debuggame('Game #%d crashed @%sx', this.game.id, crash);
  this.lastServerSeed  = data.hash;
  this.game.serverSeed = data.hash;
  this.game.crashPoint = data.game_crash;
  this.game.forced     = data.forced;
  this.game.state      = 'ENDED';

  // Add the bonus to each user that wins it
  for (var playerName in data.bonuses) {
    console.assert(this.game.players[playerName]);
    this.game.players[playerName].bonus = data.bonuses[playerName];
  }

  var gameInfo = this.getGameInfo();
  // Add the current game info to the game history and if the
  // game history is larger than 40 remove one element
  if (this.gameHistory.length >= 40)
    this.gameHistory.pop();
  this.gameHistory.unshift(gameInfo);

  if (this.userState == 'PLAYING' ||
      this.state == 'CASHINGOUT') {
    debuguser('User state: %s -> CRASHED', this.userState);
    this.userState = 'CRASHED';
    this.emit('user_loss', data);
  }

  this.emit('game_crash', data, gameInfo);
};

Client.prototype.onPlayerBet = function(data) {
  this.game.players[data.username] = data;

  if (this.username === data.username) {
    debuguser('User state: %s -> PLACED', this.userState);
    this.userState = 'PLACED';
    // TODO: deprecate after server upgrade
    if (!data.hasOwnProperty('index'))
        this.balance -= data.bet;
    this.emit('player_bet', data);
    this.emit('user_bet', data);
  } else {
    debuggame('Player bet: %s', JSON.stringify(data));
    this.emit('player_bet', data);
  }
};

Client.prototype.onCashedOut = function(data) {
  /* Example:
       { "username":"Steve",
         "stopped_at":2097
       }
  */

  console.assert(this.game.players[data.username]);
  var player = this.game.players[data.username];
  player.stopped_at = data.stopped_at;

  if (this.username === data.username) {
    debuguser('User cashout @%d: PLAYING -> CASHEDOUT', data.stopped_at);
    this.balance += player.bet * data.stopped_at / 100;
    this.userState = 'CASHEDOUT';
    this.emit('cashed_out', data);
    this.emit('user_cashed_out', data);
  } else {
    debuggame('Player cashout @%d: %s', data.stopped_at, data.username);
    this.emit('cashed_out', data);
  }
};

Client.prototype.onMsg = function(msg) {
  debugchat('Msg: %s', JSON.stringify(msg));
  // Add the current chat message to the chat history
  if (this.chatHistory.length >= 100)
    this.chatHistory.pop();
  this.chatHistory.unshift(msg);
  this.emit('msg', msg);
};

Client.prototype.doBet = function(amount, autoCashout) {
  debuguser('Bet: %d @%d', amount, autoCashout);

  if (this.userState != 'WATCHING')
    return console.error('Cannot place bet in state: ' + this.userState);

  this.userState = 'PLACING';
  this.socket.emit('place_bet', amount, autoCashout, function(err) {
    if (err) console.error('Place bet error:', err);
  });
};

Client.prototype.doCashout = function() {
  debuguser('Cashing out');
  if (this.userState != 'PLAYING' &&
      this.userState != 'PLACING' &&
      this.userState != 'PLACED')
    return console.error('Cannot cashout in state: ' + this.userState);

  this.userState = 'CASHINGOUT';
  this.socket.emit('cash_out', function(err) {
    if (err) console.error('Cashing out error:', err);
  });
};

Client.prototype.doSetAutoCashout = function(at) {
  debuguser('Setting auto cashout: %d', at);
  if (this.userState != 'PLAYING' &&
      this.userState != 'PLACING' &&
      this.userState != 'PLACED')
    return console.error('Cannot set auto cashout in state: ' + this.userState);

  this.socket.emit('set_auto_cash_out', at);
};

Client.prototype.doSay = function(line) {
  debugchat('Saying: %s', line);
  this.socket.emit('say', line);
};

Client.prototype.doMute = function(user, timespec) {
  debugchat('Muting user: %s time: %s', user, timespec);
  var line = '/mute ' + user;
  if (timespec) line = line + ' ' + timespec;
  this.socket.emit('say', line);
};

Client.prototype.getLastTick = function() {
  if (this.game.ticks.length > 0)
    return _.last(this.game.ticks);
  else
    return { elapsed: 0,
             growth: 100,
             micro: 0
           };
};

Client.prototype.elapsedToMicro = function(elapsed) {
  this.tickModel.evaluate(elapsed);
};

Client.prototype.estimateTickTimeDiff = function() {
  var diffs = [];
  var ticks = this.game.ticks;

  if (ticks.length < 2)
    return { lower: 0, upper: 0 };
  if (ticks.length < 3) {
    var t = ticks[1].elapsed - ticks[0].elapsed;
    return { lower: t, upper: t };
  }
  if (ticks.length < 4) {
    var t1 = ticks[1].elapsed - ticks[0].elapsed;
    var t2 = ticks[2].elapsed - ticks[1].elapsed;

    return { lower: Math.min(t1,t2),
             upper: Math.max(t1,t2)
           };
  }

  for (var i = 1; i < ticks.length; ++i)
    diffs.push(ticks[i].elapsed - ticks[i-1].elapsed);

  diffs.sort(function(a,b) { return a - b; });
  return { lower: diffs[Math.floor(0.05 * diffs.length)],
           upper: diffs[Math.floor(0.95 * diffs.length)]
         };
};

Client.prototype.estimateNextTick = function() {
  var last = this.getLastTick();
  var tickdiff = this.estimateTickTimeDiff();

  // Lower estimate
  var lower_elapsed  = Math.floor(last.elapsed + tickdiff.lower);
  var lower_tickInfo =
    { elapsed: lower_elapsed,
      growth:  Lib.growthFunc(lower_elapsed),
      micro:   this.elapsedToMicro(lower_elapsed)
    };

  // Upper estimate
  var upper_elapsed  = Math.floor(last.elapsed + tickdiff.upper);
  var upper_tickInfo =
    { elapsed:    upper_elapsed,
      growth:     Lib.growthFunc(upper_elapsed),
      micro:      this.elapsedToMicro(upper_elapsed)
    };

  return { lower: lower_tickInfo, upper: upper_tickInfo };
};

Client.prototype.timeTillStart = function() {
  return this.startTime - Date.now();
}

Client.prototype.getPlayers = function() {
  return this.game.players;
};

Client.prototype.getGameInfo = function() {
  var gameInfo =
    { elapsed:          Date.now() - this.game.startTime,
      game_id:          this.game.id,
      server_seed_hash: this.game.serverSeedHash,
      player_info:      this.game.players,
      state:            this.game.state,
      ticks:            this.game.ticks,
      micro_time:       this.game.microStartTime
    };

  if (this.game.state === 'ENDED') {
    var cp   = Lib.crashPoint(this.game.serverSeed);
    var diff = Math.abs(cp - this.game.crashPoint);

    gameInfo.game_crash  = this.game.crashPoint;
    gameInfo.server_seed = this.game.serverSeed;

    // The crashpoint calculation is a floating point calculation and as such
    // is imprecise. Above 1,000,000x we allow the crashpoint to differ by
    // 0.08x, below it must be equal.
    gameInfo.verified    =
      diff === 0 || cp > 1e6 && diff < 0.08 ? "ok" : "scam";
  }

  return gameInfo;
};

// Get a one time token from the server to join the game.
function getOtt(config, cb) {
  if (!config.session) return cb(null);

  var cookie  = "id=" + config.session;
  var options =
    {
      hostname: config.webserver_host,
      port:     config.webserver_port,
      path: '/ott',
      method: 'POST',
      headers:
      { 'connection':     'keep-alive',
        'content-length': 0,
        'content-type':   'text/plain',
        'cookie':         cookie
      }
    };
  debug("Requesting one time token");

  console.assert(config.webserver_prot === 'http' ||
                 config.webserver_prot === 'https');
  var http = require(config.webserver_prot);
  var req = http.request(options, function(res) {
    res.on('data', cb);
  });
  req.end();
  req.on('error', function(e) {
    console.error('Error getting ott:' + e);
  });
}
