'use strict'

const EventEmitter = require('events').EventEmitter

const OrbitDB = require('orbit-db')
const Logger = require('logplease')

const Channel = require('./Channel')

const logger = Logger.create('Orbit', { color: Logger.Colors.Green })

Logger.setLogLevel(
  process.env.NODE_ENV === 'development' ? Logger.LogLevels.DEBUG : Logger.LogLevels.ERROR
)

class Orbit {
  constructor (ipfs, options) {
    this.events = new EventEmitter()
    this._ipfs = ipfs
    this._orbitdb = null
    this._userProfile = null
    this._channels = {}
    this._peers = []
    this._pollPeersTimer = null
    this._options = options || {}
    this._joiningQueue = {}
    this._connecting = false
  }

  /* Public properties */

  get userProfile () {
    return this._userProfile
  }

  get channels () {
    return this._channels
  }

  get identity () {
    return this._orbitdb ? this._orbitdb.identity : null
  }

  get peers () {
    return this._peers
  }

  get online () {
    return !!this._orbitdb
  }

  /* Public methods */

  static async create (ipfs, options) {
    const node = new Orbit(ipfs, options)
    await node.connect()
    return node
  }

  async connect (username) {
    if (this._orbitdb) throw new Error('Already connected')
    if (this._connecting) throw new Error('Already connecting')
    else this._connecting = true

    if (username) {
      if (typeof username !== 'string') throw new Error("'username' must be a string")
      this._options.id = username
    }

    this._userProfile = {
      name: this._options.id,
      location: 'Earth',
      image: null
    }

    logger.info(`Connecting to Orbit as "${this.userProfile.name}""`)

    this._orbitdb = await OrbitDB.createInstance(this._ipfs, this._options)

    this._startPollingForPeers()

    logger.info(`Connected to Orbit as "${this.userProfile.name}"`)

    this.events.emit('connected', this.userProfile)
  }

  async disconnect () {
    if (!this._orbitdb) return

    logger.warn('Disconnected')

    await this._orbitdb.disconnect()
    this._connecting = false
    this._orbitdb = null
    this._userProfile = null
    this._channels = {}

    if (this._pollPeersTimer) clearInterval(this._pollPeersTimer)

    this.events.emit('disconnected')
  }

  join (channelName, options) {
    if (!channelName || channelName === '') {
      return Promise.reject(new Error('Channel not specified'))
    } else if (this._channels[channelName]) {
      return Promise.resolve(this._channels[channelName])
    } else if (!this._joiningQueue[channelName]) {
      this._joiningQueue[channelName] = new Promise(resolve => {
        logger.debug(`Join #${channelName}`)

        const channelOptions = Object.assign(
          {
            accessController: {
              write: ['*'] // Allow anyone to write to the channel
            }
          },
          options || {}
        )

        this._orbitdb.log(channelName, channelOptions).then(feed => {
          this._channels[channelName] = new Channel(this, channelName, feed)
          logger.debug(`Joined #${channelName}, ${feed.address.toString()}`)
          this.events.emit('joined', channelName, this._channels[channelName])
          delete this._joiningQueue[channelName]
          resolve(this._channels[channelName])
        })
      })
    }

    return this._joiningQueue[channelName]
  }

  async leave (channelName) {
    const channel = this.channels[channelName]

    if (channel) {
      await channel.feed.close()
      delete this._channels[channelName]
      logger.debug('Left channel #' + channelName)
    }

    this.events.emit('left', channelName)
  }

  async send (channelName, message, replyToHash) {
    if (!channelName || channelName === '') throw new Error('Channel must be specified')
    if (!message || message === '') throw new Error("Can't send an empty message")
    if (!this.userProfile) throw new Error("Something went wrong: 'userProfile' is undefined")

    logger.debug(`Send message to #${channelName}: ${message}`)

    const data = {
      content: message.substring(0, 2048),
      meta: { from: this.userProfile, type: 'text', ts: new Date().getTime() }
    }

    return this._postMessage(channelName, data)
  }

  /*
    addFile(channel, source) where source is:
    {
      // for all files, filename must be specified
      filename: <filepath>,    // add an individual file
      // and optionally use one of these in addition
      directory: <path>,       // add a directory
      buffer: <Buffer>,        // add a file from buffer
      // optional meta data
      meta: <meta data object>
    }
  */
  async addFile (channelName, source) {
    if (!source || (!source.filename && !source.directory)) {
      throw new Error('Filename or directory not specified')
    }

    async function _addToIpfsJs (data) {
      const result = await this._ipfs.add(Buffer.from(data))
      const isDirectory = false
      const hash = result.cid.toString()
      return { hash, isDirectory }
    }

    async function _addToIpfsGo (filename, filePath) {
      const result = await this._ipfs.add({ path: filePath })
      // last added hash is the filename --> we added a directory
      // first added hash is the filename --> we added a file
      const isDirectory = result.path.split('/').pop() !== filename
      const hash = result.cid.toString()
      return { hash, isDirectory }
    }

    logger.info(`Adding file from path '${source.filename}'`)

    const isBuffer = source.buffer && source.filename
    const name = source.directory
      ? source.directory.split('/').pop()
      : source.filename.split('/').pop()
    const size = source.meta && source.meta.size ? source.meta.size : 0

    let addToIpfs

    if (isBuffer) {
      // Adding from browsers
      addToIpfs = _addToIpfsJs.bind(this, source.buffer)
    } else if (source.directory) {
      // Adding from Electron
      addToIpfs = _addToIpfsGo.bind(this, name, source.directory)
    } else {
      addToIpfs = _addToIpfsGo.bind(this, name, source.filename)
    }

    const upload = await addToIpfs()

    logger.info(`Added file '${source.filename}' as`, upload)

    // Create a post
    const data = {
      content: upload.hash,
      meta: Object.assign(
        {
          from: this.userProfile,
          type: upload.isDirectory ? 'directory' : 'file',
          ts: new Date().getTime()
        },
        { size, name },
        source.meta || {}
      )
    }

    return this._postMessage(channelName, data)
  }

  getFile (hash) {
    return this._ipfs.cat(hash)
  }

  getDirectory (hash) {
    return this._ipfs.ls(hash).then(res => res.Objects[0].Links)
  }

  /* Private methods */

  _postMessage (channelName, data) {
    const feed = this._getChannelFeed(channelName)
    return feed.add(data)
  }

  _getChannelFeed (channelName) {
    if (!channelName || channelName === '') throw new Error('Channel not specified')
    const feed = this.channels[channelName].feed || null
    if (!feed) throw new Error(`Have not joined #${channelName}`)
    return feed
  }

  _startPollingForPeers () {
    async function update () {
      try {
        this._peers = (await this._updateSwarmPeers()) || []
        // TODO: get unique (new) peers and emit 'peer' for each instead of all at once
        this.events.emit('peers', this._peers)
      } catch (e) {
        logger.error(e)
      }
    }

    if (!this._pollPeersTimer) this._pollPeersTimer = setInterval(update.bind(this), 3000)
  }

  async _updateSwarmPeers () {
    try {
      const peers = await this._ipfs.swarm.peers()
      return Object.keys(peers)
        .filter(e => peers[e].addr !== undefined)
        .map(e => peers[e].addr.toString())
    } catch (e) {
      logger.error(e)
    }
  }
}

module.exports = Orbit
