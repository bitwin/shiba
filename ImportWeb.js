var Parser  = require('jq-html-parser');
var async   = require('async');
var request = require('request');
var fs      = require('fs');
var debug   = require('debug')('shiba:import');
var pg      = require('pg');

var Config  = require('./Config')('production');
var Pg      = require('./Pg');

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir); }
  catch(e) { if (e.code != 'EEXIST') throw e; }
}
ensureDirSync('gamelogs');
ensureDirSync('gamelogs/web');

var parserconfig =
  { game_id: { selector: 'div.content strong' },
    crashpoint:
     { selector: 'div.content p:first',
       ignore: 'b' },
    created:
     { selector: 'div.content p:nth-of-type(2)',
       ignore: 'b,small' },
    players:
     { selector: 'table.user-table tbody tr td:first-child',
       multiple: true },
    wager:
     { selector: 'table.user-table tbody tr td:nth-child(2)',
       multiple: true,
       regexp: '([0-9,]+) bits' },
    cashedout:
     { selector: 'table.user-table tbody tr td:nth-child(3)',
       multiple: true },
    profit:
     { selector: 'table.user-table tbody tr td:nth-child(5)',
       multiple: true,
       regexp: '(-?([0-9,.])*) bits' },
    server_seed: { selector: 'h6:nth-of-type(2) a' } };
var parser = new Parser(parserconfig);

function html2json(html) {
    var rawGameInfo = parser.parse(html);

    if (!rawGameInfo.crashpoint) {
        console.error('Error no crashpoint: ' + html);
        console.error(rawGameInfo);
        return null;
    }

    // Extract crashpoint
    var gameCrash = rawGameInfo.crashpoint.replace(/,|\.|x/g, '');

    if (!gameCrash) {
        console.log('Error parsing crashpoint');
        console.log('Match:', gameCrash);
        throw undefined;
    }

    var game_crash = parseInt(gameCrash, 10);

    // Extract player info
    var player_info = {};

    for (var i = 0; i < rawGameInfo.players.length; ++i) {

        var info = {};
        player_info[rawGameInfo.players[i]] = info;

        // Extract player's wager.
        var rawBet = parseInt(rawGameInfo.wager[i].replace(/,/g, ''));;
        info.bet = 100 * rawBet;

        // Extract the profit.
        var profit = parseInt(rawGameInfo.profit[i].replace(/\.|,|\+|x/g, ''), 10);
        info.profit = profit;

        // Extract the cashout amount.
        var cashout = rawGameInfo.cashedout[i].replace(/\.|,|\+|x/g, '');
        var cashoutReg = /^(\d+|Lose)$/;
        var cashoutMatch = cashout.match(cashoutReg);

        if (!cashoutMatch) {
            console.log('Error parsing cashout:', cashout);
            console.log(rawGameInfo);
            throw undefined;
        }

        if (cashoutMatch[1] != 'Lose') {
            info.stopped_at = parseInt(cashoutMatch[1], 10);
            info.amount = info.stopped_at * rawBet;

            if (profit != info.amount - info.bet)
                info.bonus = profit - (info.amount - info.bet);
        } else {
            if (profit != - info.bet)
                info.bonus = info.bet + profit;
        }
    }

    var gameinfo =
      { created:     new Date(rawGameInfo.created),
        ended:       true,
        game_crash:  game_crash,
        game_id:     rawGameInfo.game_id,
        server_seed: rawGameInfo.server_seed,
        player_info: player_info
      };

    return gameinfo;
}

function getGameInfo(id, cb) {
  var url =
    Config.webserver_prot + '://' +
    Config.webserver_host +
    (Config.webserver_port ? ':' + Config.webserver_port : '') +
    '/game/' + id;

  request(url, function (err, res, body) {
    if (err || res.statusCode != 200)
      return cb(err || res.statusCode);

    try {
      return cb(null, html2json(body));
    } catch(e) {
      return cb(e);
    }
  });
}

function importGame(id, cb) {
  getGameInfo(id, function (err, info) {
    if (err) {
      console.error('Downloading game #' + id, 'failed');
      return cb(err);
    }

    async.parallel(
      [ function(cb) {
	  Pg.putGame(info, function (err) {
	    if (err) {
              console.error('Importing game #' + info.game_id, 'failed');
	    } else {
              console.log('Imported game #' + info.game_id);
	    }
	    return cb(err);
	  });
	},
	function (cb) {
	  var gameLogFile = 'gamelogs/web/' + info.game_id + '.json';
	  fs.writeFile(gameLogFile, JSON.stringify(info, null, ' '), function(err) {
	    if (err) {
              console.error('Importing game #' + info.game_id, 'failed');
	    } else {
              console.log('Imported game #' + info.game_id);
	    }
	    return cb(err);
	  });
	}
      ], cb);
  });
}

var ids = process.argv.slice(2);

async.eachSeries(ids, importGame, function (err) {
  if (err) return console.error('Error', err);
  pg.end();
});
