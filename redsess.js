module.exports = RedSess

var redis = require("redis")
RedSess.client = null

var Cookies = require('cookies')
var util = require('util')
var redisAtomicJSON = require('redis-atomic-json')

// optional dependency
try { var KeyGrip = require('keygrip') } catch (e) {}

function RedSess (req, res, opt) {
  if (!(this instanceof RedSess))
    return new RedSess(req, res, opt)

  opt = opt || {}
  if (!RedSess.client && !opt.client) {
    console.error('RedSess: no client yet', req.url, req.headers)
    res.statusCode = 503
    res.setHeader('content-type', 'text/plain')
    res.setHeader('retry-after', '10')
    res.end('Redis client not yet loaded.\n')
    return
  }

  if (opt.client) redisAtomicJSON.wrap(opt.client)

  // if we got an array of strings rather than a keygrip, then
  // keygrip it up.
  if (opt.keys) {
    if (!KeyGrip)
      throw new Error('keys provided by KeyGrip not available')
    else if (Array.isArray(opt.keys))
      this.keys = new KeyGrip(opt.keys)
    else if (opt.keys instanceof KeyGrip)
      this.keys = opt.keys
    else
      throw new Error('invalid keys provided')
  }

  // 2 week sessions by default.
  this.expire = opt.expire || 60 * 60 * 24 * 14

  // set up the cookies thingie
  this.cookies = opt.cookies || new Cookies(req, res, this.keys)

  // set the s-cookie
  var name = this.cookieName = opt.cookieName || 's'
  var expireDate = new Date(Date.now() + (this.expire*1000))
  var cookieOptions = opt && opt.cookieOptions || {}
  var copt = util._extend({
    expires: expireDate,
    signed: !!this.keys
  }, cookieOptions)

  var s = this.cookies.get(name, copt)
  if (!s)
    s = opt.token || require('crypto').randomBytes(30).toString('base64')

  if (res)
    this.cookies.set(name, s, copt)

  this.token = s

  if (!this.token)
    throw new Error('could not load session token')

  this.id = "session:" + this.token
  this.client = opt.client || RedSess.client
  this.request = req
  this.response = res
}

RedSess.setClient = function (client) {
  RedSess.client = client
}

RedSess.createClient = function (conf) {
  conf = conf || {}
  RedSess.client = redis.createClient(conf.port, conf.host, conf)
  if (conf.auth)
    RedSess.client.auth(conf.auth)
  return redisAtomicJSON.wrap(RedSess.client)
}

RedSess.quit = RedSess.close = RedSess.end = function (cb) {
  if (!RedSess.client)
    return cb && cb()
  if (cb)
    RedSess.client.once("end", cb)
  RedSess.client.quit()
}

RedSess.destroy = function () {
  RedSess.client.end()
}

RedSess.prototype.del = function (k, cb) {
  if (typeof k === 'function' || !k && !cb)
    return this.delAll(k || cb)

  this.client.jdel(this.id, k, function (er) {
    this.client.expire(this.id, this.expire)
    if (cb)
      return cb(er)
  }.bind(this));
}

RedSess.prototype.delAll = function (cb) {
  this.client.del(this.id, cb || function(){})
}

// delete all data, and kill the session entirely
RedSess.prototype.destroy = function (cb) {
  this.client.del(this.id, function (er) {
    this.cookies.set(this.cookieName, '', {
      expires: new Date(0),
      signed: !!this.keys
    })
    cb(er)
  }.bind(this))
}

RedSess.prototype.set = function (k, v, cb) {
  if (typeof v === 'function')
    cb = v, v = null

  var callback = function(er) {
    this.client.expire(this.id, this.expire)
    if (cb)
      return cb(er)
  }.bind(this)

  if (v) this.client.jset(this.id, k, v, callback)
  else this.client.jset(this.id, k, callback)
}

RedSess.prototype.get = function (k, cb) {
  if (typeof k === 'function' || !k)
    return this.getAll(k || cb)

  if (!cb)
    return this.client.expire(this.id, this.expire)

  this.getAll(function (er, all) {
    if (er || !all)
      return cb(er, null)
    return cb(null, all.hasOwnProperty(k) ? all[k] : null)
  }.bind(this))
}

RedSess.prototype.getAll = function (cb) {
  // if no cb, then just update the expiration
  if (!cb)
    return this.client.expire(this.id, this.expire)

  this.client.get(this.id, function (er, data) {
    this.client.expire(this.id, this.expire)
    if (!er)
      data = parse(data)
    cb(er, data)
  }.bind(this))
}

function parse(str) {
  try {
    return JSON.parse(str) || {}
  } catch (er) {
    return {}
  }
}

function stringify(obj) {
  try {
    return JSON.stringify(obj) || ""
  } catch (er) {
    return ""
  }
}
