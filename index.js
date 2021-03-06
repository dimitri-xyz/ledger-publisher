var datax = require('data-expression')
var Joi = require('joi')
var jsdom = require('jsdom').jsdom
var random = require('random-lib')
var tldjs = require('tldjs')
var trim = require('underscore.string/trim')
var underscore = require('underscore')
var url = require('url')

/* foo.bar.example.com
    QLD = 'bar'
    RLD = 'foo.bar'
    SLD = 'example.com'
    TLD = 'com'

   search.yahoo.co.jp
    QLD = 'search'
    RLD = 'search'
    SLD = 'yahoo.co.jp'
    TLD = 'co.jp'
 */

var schema = Joi.array().items(Joi.object().keys(
  { condition: Joi.alternatives().try(Joi.string().description('a JavaScript boolean expression'),
                                      Joi.boolean().allow(true).description('only "true" makes sense')).required(),
    consequent: Joi.alternatives().try(Joi.string().description('a JavaScript string expression'),
                                      Joi.any().allow(false, null).description('or null').required()),
    dom: Joi.any().optional().description('DOM equivalent logic'),
    description: Joi.string().optional().description('a brief annotation')
  }
))

var rules = [
/*
 * EXPERIMENTAL: youtube channel publishers
 */
 { condition: "SLD === 'youtube.com' && pathname.indexOf('/channel/') === 0",
   consequent: 'SLD + pathname',
   dom: {
     faviconURL: {
       nodeSelector: 'img.channel-header-profile-image',
       consequent: 'node.getAttribute("src")'
     }
   }
 },
 { condition: "SLD === 'youtube.com' && pathname === '/watch'",
   dom: {
     publisher: {
       nodeSelector: "#watch7-content.watch-main-col meta[itemprop='channelId']",
       consequent: '"youtube.com/channel/" + node.getAttribute("content")'
     },
     faviconURL: {
       nodeSelector: '#watch7-user-header.spf-link img',
       consequent: 'node.getAttribute("data-thumb")'
     }
   }
 },

 { condition: "[ 'baidu', 'bing', 'google', 'sogou', 'yahoo', 'yandex', 'youdao' ].indexOf(SLD.split('.')[0]) !== -1",
   consequent: null,
   description: 'search engines'
 },
 { condition: "[ 'twimg', 'ytimg' ].indexOf(SLD.split('.')[0]) !== -1",
   consequent: null,
   description: 'image stores'
 },
 { condition: "[ 'campaign-archive1', 'campaign-archive2' ].indexOf(SLD.split('.')[0]) !== -1",
   consequent: null,
   description: 'campaign engines'
 },

 { condition: true,
   consequent: 'SLD',
   description: 'the default rule'
 }
]

var getPublisher = function (location, markup) {
  var consequent, i, props, result, rule

  if (!tldjs.isValid(location)) return

  props = url.parse(location, true)
  props.TLD = tldjs.getPublicSuffix(props.host)
  if (!props.TLD) return

  props = underscore.mapObject(props, function (value, key) { if (!underscore.isFunction(value)) return value })
  props.URL = location
  props.SLD = tldjs.getDomain(props.host)
  props.RLD = tldjs.getSubdomain(props.host)
  props.QLD = props.RLD ? underscore.last(props.RLD.split('.')) : ''

  for (i = 0; i < rules.length; i++) {
    rule = rules[i]

    if (!datax.evaluate(rule.condition, props)) continue

    if ((rule.dom) && (rule.dom.publisher)) {
      if (!markup) throw new Error('markup parameter required')

      if (typeof markup !== 'string') markup = markup.toString()

      props.node = jsdom(markup).body.querySelector(rule.dom.publisher.nodeSelector)
      consequent = rule.dom.publisher.consequent
    } else {
      delete props.node
      consequent = rule.consequent
    }

    result = consequent ? datax.evaluate(consequent, props) : consequent
    if (result === '') continue

    if (typeof result === 'string') return trim(result, './')

    // map null/false to undefined
    return
  }
}

var isPublisher = function (publisher) {
  var props
  var parts = publisher.split('/')

  if (!tldjs.isValid(parts[0])) return false
  if (parts.length === 1) return true

  props = url.parse('https://' + publisher)
  return ((!props.hash) && (!props.search))
}

var Synopsis = function (options) {
  var p

  this.publishers = {}
  if ((typeof options === 'string') || (Buffer.isBuffer(options))) {
    p = JSON.parse(options)

    options = p.options
    this.publishers = p.publishers
  }

  this.options = options || {}
  this.options.scorekeepers = underscore.keys(Synopsis.prototype.scorekeepers)
  underscore.defaults(this.options, { minDuration: 2 * 1000, numFrames: 30, frameSize: 24 * 60 * 60 * 1000,
                                      _d: 1 / (30 * 1000)
                                    })
  if (!this.options.scorekeepers[this.options.scorekeeper]) {
    this.options.scorekeeper = underscore.first(this.options.scorekeepers)
  }
  this.options.emptyScores = {}
  this.options.scorekeepers.forEach(function (scorekeeper) {
    this.options.emptyScores[scorekeeper] = 0
  }, this)

  underscore.defaults(this.options, { _a: (1 / (this.options._d * 2)) - this.options.minDuration })
  this.options._a2 = this.options._a * 2
  this.options._a4 = this.options._a2 * 2
  underscore.defaults(this.options, { _b: this.options.minDuration - this.options._a })
  this.options._b2 = this.options._b * this.options._b

  underscore.keys(this.publishers).forEach(function (publisher) {
    var i
    var entry = this.publishers[publisher]

// NB: legacy support
    if (typeof entry.scores === 'undefined') {
      entry.scores = underscore.clone(this.options.emptyScores)
      if (entry.score) {
        entry.scores.concave = entry.score
        entry.scores.visits = entry.visits
        delete entry.score
      }
    }
    for (i = 0; i < entry.window.length; i++) {
      if (typeof entry.window[i].scores !== 'undefined') continue

      entry.window[i].scores = underscore.clone(this.options.emptyScores)
      if (entry.window[i].score) {
        entry.window[i].scores.concave = entry.window[i].score
        entry.window[i].scores.visits = entry.window[i].visits
        delete entry.window[i].score
      }
    }
  }, this)
}

Synopsis.prototype.addVisit = function (location, duration, markup) {
  var publisher

  if (duration < this.options.minDuration) return

  try { publisher = getPublisher(location, markup) } catch (ex) { return }
  if (!publisher) return

  return this.addPublisher(publisher, { duration: duration, markup: markup })
}

Synopsis.prototype.initPublisher = function (publisher) {
  if (this.publishers[publisher]) return

  this.publishers[publisher] = { visits: 0, duration: 0, scores: underscore.clone(this.options.emptyScores),
                                 window: [ { timestamp: underscore.now(), visits: 0, duration: 0,
                                             scores: underscore.clone(this.options.emptyScores) } ]
                               }
}

Synopsis.prototype.addPublisher = function (publisher, props) {
  var scores
  var now = underscore.now()

  if (!props) return

  if (typeof props === 'number') props = { duration: props }
  if (props.duration < this.options.minDuration) return

  scores = this.scores(props)
  if (!scores) return

  if (!this.publishers[publisher]) this.initPublisher(publisher)

  if (this.publishers[publisher].window[0].timestamp <= now - this.options.frameSize) {
    this.publishers[publisher].window =
      [ { timestamp: now, visits: 0, duration: 0,
          scores: underscore.clone(this.options.emptyScores) }].concat(this.publishers[publisher].window)
  }

  this.publishers[publisher].window[0].visits++
  this.publishers[publisher].window[0].duration += props.duration
  underscore.keys(scores).forEach(function (scorekeeper) {
    if (!this.publishers[publisher].window[0].scores[scorekeeper]) this.publishers[publisher].window[0].scores[scorekeeper] = 0
    this.publishers[publisher].window[0].scores[scorekeeper] += scores[scorekeeper]
  }, this)

  this.publishers[publisher].visits++
  this.publishers[publisher].duration += props.duration
  underscore.keys(scores).forEach(function (scorekeeper) {
    if (!this.publishers[publisher].scores[scorekeeper]) this.publishers[publisher].scores[scorekeeper] = 0
    this.publishers[publisher].scores[scorekeeper] += scores[scorekeeper]
  }, this)

  return publisher
}

Synopsis.prototype.topN = function (n) {
  return this._topN(n, this.options.scorekeeper)
}

Synopsis.prototype.allN = function (n) {
  var results = []
  var weights = {}

  underscore.keys(Synopsis.prototype.scorekeepers).forEach(function (scorekeeper) {
    (this._topN(n, scorekeeper) || []).forEach(function (entry) {
      if (!weights[entry.publisher]) weights[entry.publisher] = underscore.clone(this.options.emptyScores)
      weights[entry.publisher][scorekeeper] = entry.weight
    }, this)
  }, this)

  underscore.keys(weights).forEach(function (publisher) {
    results.push(underscore.extend({ weights: weights[publisher] },
                                   underscore.pick(this.publishers[publisher], [ 'scores', 'visits', 'duration', 'window' ])))
  }, this)

  return results
}

Synopsis.prototype._topN = function (n, scorekeeper) {
  var i, results, total

  this.prune()

  results = []
  underscore.keys(this.publishers).forEach(function (publisher) {
    if (!this.publishers[publisher].scores[scorekeeper]) return

    results.push(underscore.extend({ publisher: publisher }, underscore.omit(this.publishers[publisher], 'window')))
  }, this)
  results = underscore.sortBy(results, function (entry) { return -entry.scores[scorekeeper] })

  if ((n > 0) && (results.length > n)) results = results.slice(0, n)
  n = results.length

  total = 0
  for (i = 0; i < n; i++) { total += results[i].scores[scorekeeper] }
  if (total === 0) return

  for (i = 0; i < n; i++) {
    results[i] = { publisher: results[i].publisher, weight: results[i].scores[scorekeeper] / total }
  }

  return results
}

Synopsis.prototype.winner = function (n) {
  var i, upper
  var point = random.randomFloat()
  var results = this.topN(n)

  upper = 0
  for (i = 0; i < results.length; i++) {
    upper += results[i].weight
    if (upper >= point) return results[i].publisher
  }
}

Synopsis.prototype.toJSON = function () {
  this.prune()

  return { options: this.options, publishers: this.publishers }
}

Synopsis.prototype.scores = function (props) {
  var emptyP = true
  var result = {}

  underscore.keys(Synopsis.prototype.scorekeepers).forEach(function (scorekeeper) {
    var score = Synopsis.prototype.scorekeepers[scorekeeper].bind(this)(props)

    result[scorekeeper] = score > 0 ? score : 0
    if (score > 0) emptyP = false
  }, this)

  if (!emptyP) return result
}

Synopsis.prototype.scorekeepers = {}

// courtesy of @dimitry-xyz: https://github.com/brave/ledger/issues/2#issuecomment-221752002
Synopsis.prototype.scorekeepers['concave'] = function (props) {
  return (((-this.options._b) + Math.sqrt(this.options._b2 + (this.options._a4 * props.duration))) / this.options._a2)
}

Synopsis.prototype.scorekeepers['visits'] = function (props) {
  return 1
}

Synopsis.prototype.prune = function () {
  var now = underscore.now()
  var then = now - (this.options.numFrames * this.options.frameSize)

  underscore.keys(this.publishers).forEach(function (publisher) {
    var i
    var duration = 0
    var entry = this.publishers[publisher]
    var scores = {}
    var visits = 0

    // NB: in case of user editing...
    if (!entry.window) {
      entry.window = [ { timestamp: now, visits: entry.visits, duration: entry.duration, scores: entry.scores } ]
      return
    }

    for (i = 0; i < entry.window.length; i++) {
      if (entry.window[i].timestamp < then) break

      visits += entry.window[i].visits
      duration += entry.window[i].duration
      underscore.keys(entry.window[i].scores).forEach(function (scorekeeper) {
        if (!scores[scorekeeper]) scores[scorekeeper] = 0
        scores[scorekeeper] += entry.window[i].scores[scorekeeper]
      }, this)
    }

    if (i < entry.window.length) {
      entry.visits = visits
      entry.duration = duration
      entry.scores = scores
      entry.window = entry.window.slice(0, i)
    }
  }, this)
}

module.exports = {
  getPublisher: getPublisher,
  isPublisher: isPublisher,
  rules: rules,
  schema: schema,
  Synopsis: Synopsis
}
