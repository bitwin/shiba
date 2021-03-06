var fs           =  require('fs');
var async        =  require('async');
var unshort      =  require('unshort');
var fx           =  require('money');
var _            =  require('lodash');
var profanity    =  require('./profanity');
var ExchangeRate =  require('./ExchangeRate');
var Blockchain   =  require('./Blockchain');

var Client       =  require('./Client');
var Convert      =  require('./Convert');
var Crash        =  require('./Crash');
var Lib          =  require('./Lib');
var Config       =  require('./Config')();
var Pg           =  require('./Pg');

var debug        =  require('debug')('shiba');
var debugblock   =  require('debug')('shiba:blocknotify');
var debugunshort =  require('debug')('shiba:unshort');

// Command syntax
var cmdReg = /^\s*!([a-zA-z]*)\s*(.*)$/i;

function Shiba() {

  var self = this;
  async.parallel(
    [ Pg.getLatestBlock,
      Pg.getBlockNotifications,
      Pg.getAutomutes
    ], function (err, val) {
      // Abort immediately on startup.
      if (err) throw err;

        // Last received block information.
      self.block = val[0];
      // Awkward name for an array that holds names of users which
      // will be when a new block has been mined.
      self.blockNotifyUsers = val[1];

      // List of automute regexps
      self.automutes = val[2];

      // Connect to the site.
      self.client = new Client(Config);

      self.setupChatHook();
      // self.setupConsoleLog();
      // self.setupLossStreakComment();
      self.setupScamComment();
      self.setupBlockchain();
    });
}

Shiba.prototype.setupChatHook = function() {
  var self = this;
  self.client.on('msg', function(msg) {
    if (msg.type != 'say') return;
    self.onSay(msg);
  });
};

Shiba.prototype.setupConsoleLog = function() {
  var self = this;
  self.client.on('game_starting', function(info) {
    var line =
        "Starting " + info.game_id +
        " " + info.server_seed_hash.substring(0,8);
    process.stdout.write(line);
  });

  self.client.on('game_started', function(data) {
    process.stdout.write(".. ");
  });

  self.client.on('game_crash', function(data) {
    var gameInfo = self.client.getGameInfo();
    var crash = Lib.formatFactor(data.game_crash);
    process.stdout.write(" @" + crash + "x " + gameInfo.verified + "\n");
  });
};

Shiba.prototype.setupLossStreakComment = function() {
  var self = this;
  self.client.on('game_crash', function(data) {
    var gameHistory = self.client.gameHistory;

    // Determine loss streak
    var streak = gameHistory.length > 3;
    for (var i = 0; i < Math.min(gameHistory.length - 1, 4); ++i)
      streak = streak && gameHistory[i].game_crash <= 130;

    // Don't repeat yourself in a streak
    streak = streak && (gameHistory.length < 4 ||
                        gameHistory[i + 1].game_crash > 130);

    if (streak) self.client.doSay("wow. such rape. very butthurt");
  });
};

Shiba.prototype.setupScamComment = function() {
  var self = this;
  self.client.on('game_crash', function(data) {
    var gameInfo = self.client.getGameInfo();
    console.assert(gameInfo.hasOwnProperty('verified'));
    if (gameInfo.verified != 'ok') {
      self.client.doSay('wow. such scam. very hash failure.');
    }
  });
};

Shiba.prototype.setupBlockchain = function() {
  this.blockchain = new Blockchain();
  this.blockchain.on('block', this.onBlock.bind(this));
};

Shiba.prototype.onBlock = function(block) {
  var newBlock =
    { height: block.height,
      hash: block.hash,
      confirmation: new Date(block.time*1000),
      notification: new Date()
    };

  Pg.putBlock(newBlock, function(err) {
    if (err) console.error('Error putting block:', err);
  });

  // Check if block is indeed new and only signal in this case.
  if (newBlock.height > this.block.height) {
    this.block = newBlock;

    if (this.blockNotifyUsers.length > 0) {
      var users = this.blockNotifyUsers.join(': ') + ': ';
      var line = users + 'Block #' + newBlock.height + ' mined.';
      this.client.doSay(line);
      this.blockNotifyUsers = [];
      Pg.clearBlockNotifications(function(err) {});
    }
  }
};

Shiba.prototype.getChatMessages = function(username, after) {
  var messages = [];
  var chatHistory = this.client.chatHistory;
  for (var i = 0; i < chatHistory.length; ++i) {
    var then = new Date(chatHistory[i].time);
    if (then < after) break;

    if (chatHistory[i].type === 'say' &&
        chatHistory[i].username === username)
      messages.push(chatHistory[i]);
  }
  return messages;
};

Shiba.prototype.onSay = function(msg) {
  if (msg.username === this.client.username) return;

  // Match entire message against the regular expressions.
  for (var r = 0; r < this.automutes.length; ++r)
    if (msg.message.match(this.automutes[r]))
      return this.client.doMute(msg.username, '12h');

  // Extract a list of URLs.
  // TODO: The regular expression could be made more intelligent.
  var urls = msg.message.match(/https?:\/\/[^\s]+/ig) || [];

  var urls2 = msg.message.match(/(\s|^)bit.ly\/[^s]+/ig);
  if (urls2) {
    for (var i = 0; i < urls2.length; ++i)
      urls2[i] = 'http://' + urls2[i].replace(/^\s+/g,'');
    urls = urls.concat(urls2);
  }
  var urls3 = msg.message.match(/(\s|^)goo.gl\/[^s]+/ig);
  if (urls3) {
    for (var i = 0; i < urls3.length; ++i)
      urls3[i] = 'http://' + urls3[i].replace(/^\s+/g,'');
    urls = urls.concat(urls3);
  }

  if (urls.length > 0)
    debugunshort('Found urls:' + JSON.stringify(urls));

  // Unshorten extracted URLs.
  var self = this;
  async.map(urls, unshort, function(err, urls2) {
    debugunshort('Unshorted finished: ' + JSON.stringify(urls2));

    if (err) {
      console.error("Got error while unshortening: '" + err + "'");
      console.error("Urls was:", JSON.stringify(urls));
      console.error("Urls2 is:", JSON.stringify(urls2));
    }
    urls = urls.concat(urls2);

    debugunshort('Url list: ' + JSON.stringify(urls));
    for (var i = 0; i < urls.length; ++i) {
      var url    = urls[i];
      if (typeof url != 'string') continue;
      debugunshort('Checking url: ' + url);

      // Run the regular expressions against the unshortened url.
      for (var r = 0; r < self.automutes.length; ++r)
        if (url.match(self.automutes[r])) {
          debugunshort('URL matched ' + self.automutes[r]);
          return self.client.doMute(msg.username, '48h');
        }
    }

    var after, messages;
    // Rate limiter < 4 messages in 1s
    after    = new Date(Date.now() - 1000);
    messages = self.getChatMessages(msg.username, after);
    if (messages.length >= 4) return self.client.doMute(msg.username, '15m');

    // Rate limiter < 5 messages in 5s
    after    = new Date(Date.now() - 5000);
    messages = self.getChatMessages(msg.username, after);
    if (messages.length >= 5) return self.client.doMute(msg.username, '15m');

    // Rate limiter < 8 messages in 12s
    after    = new Date(Date.now() - 12000);
    messages = self.getChatMessages(msg.username, after);
    if (messages.length >= 8) return self.client.doMute(msg.username, '15m');

    // Everything checked out fine so far. Continue with the command
    // processing phase.
    var cmdMatch = msg.message.match(cmdReg);
    if (cmdMatch) self.onCmd(msg, cmdMatch[1], cmdMatch[2]);
  });
};

Shiba.prototype.onCmd = function(msg, cmd, rest) {
  // Cmd rate limiter
  var after    = new Date(Date.now() - 10000);
  var messages = this.getChatMessages(msg.username, after);
  var rate = 0;

  for (var i = 0; i < messages.length; ++i)
    if (messages[i].message.match(cmdReg)) ++rate;

  if (rate >= 4)
    return this.client.doMute(msg.username, '5m');
  else if (rate >= 3)
    return this.client.doSay('bites ' + msg.username);

  switch(cmd.toLowerCase()) {
  case 'custom': this.onCmdCustom(msg, rest); break;
  case 'lick': this.onCmdLick(msg, rest); break;
  case 'seen': this.onCmdSeen(msg, rest); break;
  case 'faq':
  case 'help':
      this.onCmdHelp(msg, rest);
      break;
  case 'convert':
  case 'conver':
  case 'conv':
  case 'cv':
  case 'c':
      this.onCmdConvert(msg, rest);
      break;
  case 'block': this.onCmdBlock(msg, rest); break;
  case 'crash': this.onCmdCrash(msg, rest); break;
  case 'automute': this.onCmdAutomute(msg, rest); break;
  }
};

Shiba.prototype.onCmdHelp = function(msg, rest) {
  this.client.doSay(
      'very explanation. much insight: ' +
      'https://github.com/moneypot/shiba/wiki/');
};

Shiba.prototype.onCmdCustom = function(msg, rest) {
  var self = this;
  if (msg.role != 'admin' &&
      msg.role != 'moderator') return;

  var customReg   = /^([a-z0-9_\-]+)\s+(.*)$/i;
  var customMatch = rest.match(customReg);

  if (!customMatch) {
    self.client.doSay('wow. very usage failure. such retry');
    self.client.doSay('so example, very cool: !custom Ryan very dog lover');
    return;
  }

  var customUser  = customMatch[1];
  var customMsg   = customMatch[2];
  Pg.putLick(customUser, customMsg, msg.username, function (err) {
    if (err) {
      console.log('onCmdCustom:', err);
      self.client.doSay('wow. such database fail');
    } else {
      self.client.doSay('wow. so cool. very obedient');
    }
  });
};

Shiba.prototype.onCmdLick = function(msg, user) {
  var self = this;
  user = user.toLowerCase();
  user = user.replace(/^\s+|\s+$/g,'');

  // We're cultivated and don't lick ourselves.
  if (user === self.client.username.toLowerCase()) return;

  if (profanity[user]) {
    self.client.doSay('so trollol. very annoying. such mute');
    self.client.doMute(msg.username, '5m');
    return;
  }

  Pg.getLick(user, function(err, data) {
    if (err) {
      if (err === 'USER_DOES_NOT_EXIST')
        self.client.doSay('very stranger. never seen');
      return;
    }

    var username = data.username;
    var customs = data.licks;
    customs.push('licks ' + username);
    var r = Math.random() * (customs.length - 0.8);
    var m = customs[Math.floor(r)];
    self.client.doSay(m);
  });
};

Shiba.prototype.onCmdSeen = function(msg, user) {
  var self = this;
  user = user.toLowerCase();
  user = user.replace(/^\s+|\s+$/g,'');

  // Special treatment of block.
  if (user === 'block') return this.onCmdBlock(msg);

  // Avoid this.
  if (user === self.client.username.toLowerCase()) return;

  if (profanity[user]) {
    self.client.doSay('so trollol. very annoying. such mute');
    self.client.doMute(msg.username, '5m');
    return;
  }

  Pg.getLastSeen(user, function (err, message) {
    if (err) {
      if (err === 'USER_DOES_NOT_EXIST')
        self.client.doSay('very stranger. never seen');
      return;
    }

    if (!message.time) {
      // User exists but hasn't said a word.
      return self.client.doSay('very silent. never spoken');
    }

    var diff = Date.now() - message.time;
    var line;
    if (diff < 1000) {
      line = 'Seen ' + message.username + ' just now.';
    } else {
      line = 'Seen ' + message.username + ' ';
      line += Lib.formatTimeDiff(diff);
      line += ' ago.';
    }

    self.client.doSay(line);
  });
};

Shiba.prototype.onCmdCrash = function(msg, cmd) {
  var self = this;

  try {
    var qry = Crash.parser.parse(cmd);
    debug('Crash parse result: ' + JSON.stringify(qry));

    Pg.getCrash(qry, function(err, data) {
      if (err || data.length == 0) {
        // Assume that we have never seen this crashpoint.
        return self.client.doSay('wow. such absence. never seen ' + cmd);
      } else {
        data = data[0];
        var time = new Date(data.created);
        var diff = Date.now() - time;
        var info = self.client.getGameInfo();
        var line =
          'Seen ' + Lib.formatFactorShort(data.game_crash) +
          ' in #' +  data.id +
          '. ' + (info.game_id - data.id) +
          ' games ago (' + Lib.formatTimeDiff(diff) +
          ')';
        self.client.doSay(line);
      }
    });
  } catch(e) {
    console.log('Error', e);
    return self.client.doSay('wow. very usage failure. such retry');
  }
};

Shiba.prototype.onCmdConvert = function(msg, conv) {
  var self = this;
  conv = conv.replace(/^\s+|\s+$/g,'');

  try {
    conv = Convert.parser.parse(conv);
    debug('Convert parse result: ' + JSON.stringify(conv));

    ExchangeRate.getRates(function(err, rates) {
      if (err) return self.client.doSay('wow. such exchange rate fail');

      function modFactor(mod) {
        switch(mod) {
        case 'm':
          return 1e-3;
        case 'k':
        case 'K':
          return 1e3;
        case 'M':
          return 1e6;
        default:
          return 1;
        }
      }

      /* Pretty print an amount. We try to make it as pretty as
         possible by replacing ISO codes with currency symbols.
      */
      function pretty(iso, num, mod) {
        /* In case somebody specifically asked for milli we
           only print the ISO code variant.
        */
        if (mod == 'm')
          return num + " m" + iso;

        switch (iso) {
        case 'EUR': return "€"   + num + mod;
        case 'GBP': return "£"   + num + mod;
        case 'IDR': return "Rp " + num + mod;
        case 'INR': return "₹"   + num + mod;
        case 'USD': return "$"   + num + mod;
        case 'BIT': return num == 1 && mod == '' ? "1 Bit" : num + mod + " Bits";
        case 'SAT': return num + mod + " satoshi";
        case 'KOINU': return num + mod + " 子犬";
        /* Use suffix symbols for these if no modifier is
         * provided. Otherwise use the ISO code. */
        case 'PLN':
          if (modFactor(mod) == 1) {
            return num + 'zł';
          } else {
            return num + mod + ' PLN';
          }
        case 'VND':
          if (modFactor(mod) == 1) {
            return num + '₫';
          } else {
            return num + mod + ' VND';
          }
        case 'XAG':
          if (modFactor(mod) == 1) {
            return num + ' oz. tr. of silver';
          } else {
            return num + mod + ' XAG';
          }
        case 'XAU':
          if (modFactor(mod) == 1) {
            return num + ' oz. tr. of gold';
          } else {
            return num + mod + ' XAU';
          }
        default:
          return num + mod + " " + iso;
        }
      }

      fx.rates = rates;
      var result = fx.convert(conv.amount, {from: conv.fromiso, to: conv.toiso});
      result *= modFactor(conv.frommod);
      result /= modFactor(conv.tomod);

      /* Pretty print source. We reuse the original amount string for
         grouping.
      */
      var prettySource = pretty(conv.fromiso, conv.str, conv.frommod);

      /* Pretty print the converted amount. */
      /* We strip off some places because they only clutter the output:
            93473434.4234345  ->  93473434
            0.000243456487    ->  0.00024346
       */

      if (result != 0) {
        /* Scale using the exponent, but not more than 5 integral places. */
        var e = Math.min(Math.floor(Math.log(Math.abs(result)) / Math.log(10)),5);
        result = Math.round(result / Math.pow(10, e-5));
        /* Make sure that the exponent is positive during rescaling. */
        result = e-5 >= 0 ? result * Math.pow(10, e-5) : result / Math.pow(10, 5-e);
        var prec = Math.max(0, 5-e);
        if (prec > 15) {
          // Really small number and lots of places to show. Instead of printing
          // them all we rather accept scientific notation. We are already more
          // liberal than the generic toString() conversion.
          result = '' + result;
        } else {
          result = result.toFixed(prec);
        }
        /* Remove unnecessary zeroes. */
        result = result.replace(/(\.[0-9]*[1-9])0*$|\.0*$/,'$1');
      } else {
        result = '0';
      }
      var prettyResult = pretty(conv.toiso, result, conv.tomod);

      /* Send everything to the chat. */
      self.client.doSay(prettySource + " is " + prettyResult);
    });
  } catch(e) {
    return self.client.doSay('wow. very usage failure. such retry');
  }
};

Shiba.prototype.onCmdBlock = function(msg) {
  var time  = this.block.notification;
  var diff  = Date.now() - time;

  var line = 'Seen block #' + this.block.height;
  if (diff < 1000) {
    line += ' just now.';
  } else {
    line += ' ';
    line += Lib.formatTimeDiff(diff);
    line += ' ago.';
  }

  // Add the user to the list of users being notified about a new block.
  if (_.indexOf(this.blockNotifyUsers, msg.username) < 0) {
    debugblock("Adding user '%s' to block notfy list", msg.username);
    this.blockNotifyUsers.push(msg.username);
    Pg.putBlockNotification(msg.username, function(err) {});
  } else {
    debugblock("User '%s' is already on block notfy list", msg.username);
    line += ' ' + msg.username + ': Have patience!';
  }

  this.client.doSay(line);
};

Shiba.prototype.onCmdAutomute = function(msg, rest) {
  var self = this;
  if (msg.role != 'admin' &&
      msg.role != 'moderator') return;

  try {
    var match = rest.match(/^\/(.*)\/([gi]*)$/);
    var regex = new RegExp(match[1], match[2]);
  } catch(e) {
    return self.client.doSay('Regex compile file: ' + e.message);
  }

  Pg.addAutomute(msg.username, regex, function(err) {
    if (err) {
      self.client.doSay('failed adding automute to database.');
    } else {
      self.client.doSay('wow. so cool. very obedient');
      self.automutes.push(regex);
    }
  });
};

var shiba = new Shiba();
