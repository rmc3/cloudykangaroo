/**
 * Application Dependencies
 */

// Site Specific Requirements
require('./config/system-credentials.js');
var config = require('./config');

// Generic Requirements
var redis = require('redis');
var express = require('express');
var http = require('http');
var path = require('path');
var flash = require('connect-flash');
var passport = require('passport');
var useragent = require('express-useragent');

/*
  Initialize the Logging Framework
 */

// Application Logs
var ctxlog = require('contegix-logger');
var logger = ctxlog('main', 'info', { level: 'debug'});
var auditLog = ctxlog('audit', 'info', {level: 'error'}, {level: 'debug'});

// Access Logs
var reqLogger = require('express-request-logger');
var fs = require('fs');
var logstream = fs.createWriteStream(config.log.access_log, {flags: 'a'});

/*
  Connect to Redis
 */

var redisClient = redis.createClient(config.redis.port, config.redis.host);

redisClient.on('error', function (error) {
  logger.log('error', 'Redis Connect Error', { error: error });
});

redisClient.on("connect"
  , function () {
    var redisTestUUID = require('uuid').v4();
    redisClient.set('test_' + redisTestUUID, redisTestUUID);
    redisClient.get('test_' + redisTestUUID
      , function (error, response) {
          if (error)
          {
            logger.log('error', 'Error retrieving value from Redis during startup test', error);
          } else {
            if (response != redisTestUUID)
            {
              logger.log('error', 'Redis returned the incorrect value for redisTestUUID', { redisTestUUID: redisTestUUID, response: response });
            }
          }
        });
  });

/*
  Kick off the Ubersmith background update, pulls from Ubersmith and stores in Redis
 */
var ubersmith = require('ubersmith');
ubersmith.start({redisPort: config.redis.port, redisHost: config.redis.host, uberAuth: UberAuth});

/**
 * Authentication System
 */

var users = [];

passport.serializeUser(function(user, done) {
  var userId = RegExp('[^/]*$').exec(user.id)||[,null][1];
  redisClient.set("user:"+userId, JSON.stringify(user));
  done(null, userId);
});

passport.deserializeUser(function(id, done) {
  redisClient.get("user:"+id, function(err, data) {
    var user = JSON.parse(data);
    done(null, user);
  });
});

// passport-attlassian-crowd from : https://bitbucket.org/knecht_andreas/passport-atlassian-crowd
// MIT License

var AtlassianCrowdStrategy = require('passport-atlassian-crowd').Strategy;

passport.use(new AtlassianCrowdStrategy({
    crowdServer: CrowdAuth['server'],
    crowdApplication: CrowdAuth['application'],
    crowdApplicationPassword: CrowdAuth['password'],
    retrieveGroupMemberships: true
  },
  function (userprofile, done) {
    // asynchronous verification, for effect...
    process.nextTick(function () {
      var _ = require('underscore');
      var exists = _.any(users, function (user) {
        return user.id == userprofile.id;
      });

      if (!exists) {
        users.push(userprofile);
      }

      return done(null, userprofile);
    });
  }
));

/**
 * The Start of the Application Logic
 */

var app = express();

// all environments

var RedisStore = require('connect-redis')(express);

app.locals.logger = logger;
app.locals.audit = auditLog;
app.locals.moment = require('moment');
app.locals.ubersmith = ubersmith;

app.enable('trust proxy');

app.set('title', 'Cloudy Kangaroo');
app.set('port', config.http.port || 3000);
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');
app.set('sensu_uri', 'http://' + config.sensu.host + ':' + config.sensu.port);
app.set('puppetdb_uri', 'http://' + config.puppetdb.host + ':' + config.puppetdb.port + '/v3');

app.use(reqLogger.create(logger));
app.use(express.logger({stream: logstream }));

// Compress response data with gzip / deflate.
app.use(express.compress());
app.use(express.favicon());

// http://www.senchalabs.org/connect/json.html
// Parse JSON request bodies, providing the parsed object as req.body.
// MIT https://github.com/senchalabs/connect/blob/master/LICENSE
app.use(express.json({strict: true}));
app.use(express.urlencoded());
app.use(express.methodOverride());

app.use(require('connect-requestid'));
app.use(useragent.express());
app.use(flash());


/*
 Initialize the session and prepare user authentication
 */

app.use(express.cookieParser(config.cookie.secret));
app.use(express.session({
  store: new RedisStore({
    host: config.redis.host,
    port: config.redis.port
  }),
  secret: config.cookie.secret
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(express.csrf())

/*
   Route requests through the metrics and logging processing
 */
app.use(rpsMeter);

/*
  Pass the requests through the routes
 */
app.use(app.router);

/*
  Handle Errors
 */ /*
app.use(function(err, req, res, next) {
  if(!err) return next(); // you also need this line
  logger.log('error', 'Express caught error in request', { error: err, requestID: req.id, sessionID: req.sessionID});
  res.send(500);
//  next(err);
});   */

/*
  Last chance, perhaps it is a static resource, most of this offloaded to Nginx
 */
app.use(express.static(path.join(__dirname, 'public')));

/*
 * Metrics Middleware
 *  Called by app.use(rpsMeter);
 *  This adds the RPS metric, we are using this
 *  middleware so that every request is counted.
 */
var metrics = require('measured');
var collection = new metrics.Collection('http');
var rps = collection.meter('requestsPerSecond');
var timer = collection.timer('requestTime');

/*
   Periodically output metrics to the log file
 */
setInterval(function() {
  var metricslogger = ctxlog('metrics', 'debug', {level: 'error'});
  var collectionJSON = collection.toJSON();
  metricslogger.log('debug', 'metrics output', { collection: collectionJSON, type: 'metrics'});
}, config.metrics.interval || 15000);

function rpsMeter(req, res, next) {

  // Perform some work at the beginning of every request

  rps.mark();

  logger.req = req;


  // Generate csrf Token
  res.locals.token = req.csrfToken();

  // To track response time
  req._rlStartTime = new Date();

  var stopwatch = timer.start();

  req.on('end', function() {
    logger.log('debug', 'ending request', {});
    stopwatch.end();
  });

  req.on('error', function(err) {
    logger.log('error', 'Error in Express Request', { error: err });
  });

  // Save the real end that we will wrap
  // http://stackoverflow.com/questions/8719626/adding-a-hook-to-globally-log-all-node-http-responses-in-node-js-express

  var rEnd = res.end;

  // The following function will be executed when we send our response:
  res.end = function(chunk, encoding) {

    // Do the work expected
    res.end = rEnd;
    res.end(chunk, encoding);
  
    // And do the work we want now (logging!)
    req.kvLog.status = res.statusCode;
    req.kvLog.response_time = (new Date() - req._rlStartTime);

    req.kvLog.originalURL = req.originalURL || req.url;
    req.kvLog.referer = (req.referer)?req.referer:'none';

    req.kvLog.remoteAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    req.kvLog.userAgent = req.useragent.source;
    req.kvLog.isBot = req.useragent.isBot;
    req.kvLog.OS = req.useragent.OS;
    req.kvLog.Browser = req.useragent.Browser;
    req.kvLog.Platform = req.useragent.Platform;
    req.kvLog.isMobile = req.useragent.isMobile;
    req.kvLog.isDesktop = req.useragent.isDesktop;

    var level = req.kvLog._rlLevel;
    delete req.kvLog._rlLevel;

    var entry = {};
    Object.keys(req.kvLog).forEach(function(key) {
      value = req.kvLog[key];
      if (key !== 'date')
      {
        entry[key] = value;
      }
    });

    logger.log(level, 'request analytics', entry);
  };

  next();
}

/**
 * End Metrics
 */

/**
 * Development Environment Code
 */
app.configure('development', function(){
  app.use(express.errorHandler());
})

app.locals.ensureAuthenticated = function (req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  } else {
    logger.log('debug', 'user is not authenticated',  { username: 'none', requestID: req.id, sessionID: req.sessionID });
    res.render('account/login', { user: req.user, message: req.flash('error') });
  }
}

app.locals.ensureAPIAuthenticated = function (req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  } else {
    logger.log('debug', 'API client is not authenticated',  { username: 'none', requestID: req.id, sessionID: req.sessionID });
    res.send(403);
  }
}

app.locals.requireGroup = function (group) {
  return function (req, res, next) {
    if (req.isAuthenticated() && req.user && req.user.groups.indexOf(group) > -1) {
      next();
    } else {
      if (req.user) {
        logger.log('debug', req.user + ' is not a member of ' + group,  { username: req.user.username, requestID: req.id, sessionID: req.sessionID });
      } else {
        logger.log('debug', 'this request requires authentication',  { username: 'none', requestID: req.id, sessionID: req.sessionID });
      }
      res.render('account/login', { user: req.user, message: req.flash('error') });
      /*, function (err, html) {
       if (err)
       {
       logger.log('error', 'error rendering jade template', {error: err, requestID: req.id, sessionID: req.sessionID});
       res.send(500);
       } else {
       res.end(html);
       }
       });*/
    }
  }
};


app.locals.getEventClass = function (eventStatus) {
  require('enum').register();
  var StatusEnum = new Enum({'warning': 1, 'danger': 2, 'success': 0});
  var eventClass = StatusEnum.get(eventStatus);
  return eventClass;
}

app.locals.getFormattedTimestamp = function (timeStamp, dateString) {
  if (arguments.length == 1) {
    var dateString = 'MMM DD H:mm:ss';
  }
  var offset = app.locals.moment(timeStamp * 1000);
  return offset.format(dateString);
}

app.locals.getFormattedISO8601 = function (timeStamp, dateString) {
  if (arguments.length == 1) {
    var dateString = 'MMM DD H:mm:ss';
  }
  var offset = app.locals.moment(timeStamp);
  return offset.format(dateString);
}

app.locals.getCombinedDevices = function () {
  var url = app.get('puppetdb_uri') + '/nodes?query=["=", ["fact", "kernel"], "Linux"]';
  var async = require('async');
  var request = require('request')

  request({ url: url, json: true }
    , function (error, response, body) {
        if (error) {
          console.error(error);
          res.send(500);
        } else {
          var nodes = body;
          var aReturn = Array();
          var aSyncRequests = Array();
          var foundSome = false;

          aSyncRequests.push(
            function (callback) {
              var url = app.get('sensu_uri') + '/clients/';
              request({ url: url, json: true }
                , function (error, response) {
                    callback(error, response);
                }
              );
            }
          );

          aSyncRequests.push(
            function (callback) {
              redisClient.get('device.list'
                , function (error, response) {
                    callback(error, response);
                }
              );
            }
          );

          for(i = 0; i<nodes.length; i++) {
            var node = nodes[i];
            aSyncRequests.push(
              function (callback) {
                request({ url: app.get('puppetdb_uri') + '/nodes/' + node.name + '/facts', json: true}
                  , function (error, response, body) {
                      if (error) {
                        callback(error, response);
                      } else {
                        var facts = body;
                        var nodeFacts = { hostname: node.name, node: node, facts: body };
                        callback(error, nodeFacts);
                      }
                    }
                );
              }
            );
          }

          async.parallel(aSyncRequests
            , function(error, results) {
                if (error) {
                  console.log(error);
                res.send(500);
                } else {
                  return JSON.stringify(results);
                }
            }
          );
        }
    }
  );
}

app.locals.getPuppetDevice = function(hostname, getDevCallback) {
  var async = require('async');

  async.parallel([
    function (asyncCallback) {
      var request = require('request');
      request({ url: app.get('puppetdb_uri') + '/nodes/' + hostname, json: true }
        , function (error, response) {
            asyncCallback(error, response.body);
        });
    },
    function (asyncCallback) {
      var request = require('request');
      request({ url: app.get('puppetdb_uri') + '/nodes/' + hostname + '/facts', json: true }
        , function (error, response) {
            asyncCallback(error, response.body);
        });
    }
  ], function(err, results) {
      if (err)
      {
        getDevCallback(err);
      } else {
        if (results && results.length==2)
        {
          if (results[0].error)
          {
            var puppetDevice = {error: results[0].error, node: {}, facts: {}};
          } else {
            var puppetDevice = {node: results[0], facts: results[1]};
          }
          getDevCallback(err, puppetDevice);
        } else {
          getDevCallback(new Error('could not retrieve host and facts from Puppet'));
        }
      }
    });
}

app.locals.getSensuDevice = function(hostname, getDevCallback) {
  var async = require('async');
  async.parallel([
    function (asyncCallback) {
      var request = require('request');
      request({ url: app.get('sensu_uri')+ '/client/' + hostname, json: true }
        , function (error, response) {
          asyncCallback(error, response.body);
        });
    },
    function (asyncCallback) {
      var request = require('request');
      request({ url: app.get('sensu_uri') + '/events/' + hostname, json: true }
        , function (error, response) {
          asyncCallback(error, response.body);
        });
    }
  ], function(err, results) {
      if (err)
      {
        getDevCallback(err);
      } else {
        if (results && results.length==2)
        {
          if (!results[0])
          {
            var sensuDevice = {error: 'No information is known about ' + hostname, events: {}, node: {}};
          } else {
            var sensuDevice = {node: results[0], events: results[1]};
          }
          getDevCallback(err, sensuDevice);
        } else {
          app.locals.logger.log('error', 'could not retrieve events and node from Sensu', { results: JSON.stringify(results) });
          getDevCallback(new Error('could not retrieve events and node from Sensu'));
        }
      }
    });
}

require("./routes")(app, config, passport, redisClient);

if (!module.parent) {
  http.createServer(app).listen(app.get('port'), function () {
    logger.log('info', 'Express server listening on port ' + app.get('port'), {});
  });
}

module.exports = app;
