var voxel = require('voxel')
var voxelMesh = require('voxel-mesh')
var voxelChunks = require('voxel-chunks')
var ray = require('voxel-raycast')
var texture = require('voxel-texture')
var control = require('voxel-control')
var voxelView = require('voxel-view')
var Stats = require('./lib/stats')
var Detector = require('./lib/detector')
var inherits = require('inherits')
var path = require('path')
var EventEmitter = require('events').EventEmitter
if (process.browser) var interact = require('interact')
var requestAnimationFrame = require('raf')
var collisions = require('collide-3d-tilemap')
var aabb = require('aabb-3d')
var glMatrix = require('gl-matrix')
var vector = glMatrix.vec3
var SpatialEventEmitter = require('spatial-events')
var regionChange = require('voxel-region-change')
var kb = require('kb-controls')
var physical = require('voxel-physical')
var pin = require('pin-it')

module.exports = Game

function Game(opts) {
  if (!(this instanceof Game)) return new Game(opts)
  var self = this
  if (!opts) opts = {}
  if (process.browser && this.notCapable()) return
  
  if (!('generateChunks' in opts)) opts.generateChunks = true
  this.generateChunks = opts.generateChunks

  this.gravity = this.coerceVector3(opts.gravity) || [0, -0.0000036, 0]
  this.startingPosition = this.coerceVector3(opts.startingPosition) || [35,1024,35]
  this.worldOrigin = this.coerceVector3(opts.worldOrigin) || [0,0,0]

  this.configureChunkLoading(opts)
  this.THREE = opts.three || require('three');
  this.vector = vector
  this.glMatrix = glMatrix

  this.cubeSize = 1 // backwards compat
  this.chunkSize = opts.chunkSize || 32
  
  // chunkDistance and removeDistance should not be set to the same thing
  // as it causes lag when you go back and forth on a chunk boundary
  this.chunkDistance = opts.chunkDistance || 2
  this.removeDistance = opts.removeDistance || this.chunkDistance + 1
  
  this.meshType = opts.meshType || 'surfaceMesh'
  this.mesher = opts.mesher || voxel.meshers.greedy
  this.materialType = opts.materialType || this.THREE.MeshLambertMaterial
  this.materialParams = opts.materialParams || {}
  this.items = []
  this.voxels = voxel(this)
  this.chunkGroups = voxelChunks(this)
  this.height = typeof window === "undefined" ? 1 : window.innerHeight
  this.width = typeof window === "undefined" ? 1 : window.innerWidth
  this.scene = new this.THREE.Scene()

  this.view = opts.view || new voxelView(this.THREE, { width: this.width, height: this.height })
  this.view.bindToScene(this.scene)
  this.camera = this.view.getCamera()
  if (!opts.lightsDisabled) this.addLights(this.scene)

  this.collideVoxels = collisions(
    this.getBlock.bind(this),
    1,
    [Infinity, Infinity, Infinity],
    [-Infinity, -Infinity, -Infinity]
  )
  
  this.timer = this.initializeTimer((opts.tickFPS || 16))
  this.paused = false


  this.spatial = new SpatialEventEmitter
  this.region = regionChange(this.spatial, aabb([0, 0, 0], [1, 1, 1]), this.chunkSize)
  this.voxelRegion = regionChange(this.spatial, 1)
  this.chunkRegion = regionChange(this.spatial, this.chunkSize)

  // contains chunks that has had an update this tick. Will be generated right before redrawing the frame
  this.chunksNeedsUpdate = {}

  this.materials = texture({
    THREE: this.THREE,
    texturePath: opts.texturePath || './textures/',
    materialType: opts.materialType || this.THREE.MeshLambertMaterial,
    materialParams: opts.materialParams || {}
  })

  this.materialNames = opts.materials || [['grass', 'dirt', 'grass_dirt'], 'brick', 'dirt']
  
  self.chunkRegion.on('change', function(newChunk) {
    self.removeFarChunks()
  })

  if (process.browser) this.materials.load(this.materialNames)

  if (this.generateChunks) this.handleChunkGeneration()

  // client side only after this point
  if (!process.browser) return
  
  this.paused = true
  this.initializeRendering()

  for (var chunkIndex in this.voxels.chunks) this.showChunk(this.voxels.chunks[chunkIndex])

  this.initializeControls(opts)
}

inherits(Game, EventEmitter)

// # External API

Game.prototype.cameraPosition = function() {
  return this.view.cameraPosition()
}

Game.prototype.cameraVector = function() {
  return this.view.cameraVector()
}

Game.prototype.playerPosition = function() {
  var target = this.controls.target()
  if (!target) return false
  var position = target.avatar.position
  return [position.x, position.y, position.z]
}

Game.prototype.makePhysical = function(target, envelope, blocksCreation) {
  var obj = physical(target, this.potentialCollisionSet(), envelope || [1/2, 1.5, 1/2])
  obj.blocksCreation = !!blocksCreation
  return obj
}

Game.prototype.addItem = function(item) {
  if (!item.tick) {
    var newItem = physical(
      item.mesh,
      this.potentialCollisionSet(),
      [item.size, item.size, item.size]
    )
    
    if (item.velocity) {
      newItem.velocity.copy(item.velocity)
      newItem.subjectTo(this.gravity)
    }
    
    newItem.repr = function() { return 'debris' }
    newItem.mesh = item.mesh
    newItem.blocksCreation = item.blocksCreation
    
    item = newItem
  }
  
  this.items.push(item)
  if (item.mesh) this.scene.add(item.mesh)
}

Game.prototype.removeItem = function(item) {
  var ix = this.items.indexOf(item)
  if (ix < 0) return
  this.items.splice(ix, 1)
  if (item.mesh) this.scene.remove(item.mesh)
}

// only intersects voxels, not items
Game.prototype.raycast = // backwards compat
Game.prototype.raycastVoxels = function(start, direction, maxDistance) {
  if (!start) return this.raycast(this.cameraPosition(), this.cameraVector(), 10)
  
  var hitNormal = new Array(3)
  var hitPosition = new Array(3)
  var cp = start || this.cameraPosition()
  var cv = direction || this.cameraVector()
  var hitBlock = ray(this, cp, cv, maxDistance || 10.0, hitPosition, hitNormal)
  if (hitBlock === -1) return false
  
  return {
    position: hitPosition,
    direction: direction,
    value: hitBlock,
    normal: hitNormal
  }
}

Game.prototype.checkBlock = function(pos) {
  pos = this.coerceVector3(arguments)
  var floored = pos.map(function(i) { return Math.floor(i) })
  var bbox
  
  bbox = aabb(floored, [1, 1, 1])
  
  for (var i = 0, len = this.items.length; i < len; ++i) {
    var item = this.items[i]
    var itemInTheWay = item.blocksCreation && item.aabb && bbox.intersects(item.aabb())
    if (itemInTheWay) return
  }
  
  var chunkKeyArr = this.voxels.chunkAtPosition(pos)
  var chunkIndex = chunkKeyArr.join('|')
  var chunk = this.voxels.chunks[chunkIndex]
  
  if (!chunk) return
  
  var chunkPosition = this.chunkToWorld(chunk.position)
  var voxelPosition = []
  vector.subtract(voxelPosition, floored, chunkPosition)
  
  return {chunkIndex: chunkIndex, voxelVector: voxelPosition}
}

Game.prototype.createBlock = function(pos, val) {
  if (pos.chunkMatrix) return this.chunkGroups.createBlock(pos, val)
  var newBlock = this.checkBlock(pos)
  if (!newBlock) return
  var chunk = this.voxels.chunks[newBlock.chunkIndex]
  var old = chunk.voxels[this.voxels.voxelIndex(newBlock.voxelVector)]
  chunk.voxels[this.voxels.voxelIndex(newBlock.voxelVector)] = val
  this.addChunkToNextUpdate(chunk)
  this.spatial.emit('change-block', pos, old, val)
  return true
}

Game.prototype.setBlock = function(pos, val) {
  if (pos.chunkMatrix) return this.chunkGroups.setBlock(pos, val)
  var hitVoxel = this.voxels.voxelAtPosition(pos, val)
  var c = this.voxels.chunkAtPosition(pos)
  this.addChunkToNextUpdate(this.voxels.chunks[c.join('|')])
  this.spatial.emit('change-block', pos, hitVoxel, val)
}

Game.prototype.getBlock = function(pos) {
  pos = this.coerceVector3(arguments)
  if (pos.chunkMatrix) return this.chunkGroups.getBlock(pos)
  return this.voxels.voxelAtPosition(pos)
}

Game.prototype.createAdjacent = function(hit, val) {
  vector.add(hit.position, hit.position, hit.normal)
  this.createBlock(hit.position, val)
}

Game.prototype.appendTo = function (element) {
  this.view.appendTo(element)
}

Game.prototype.notCapable = function() {
  if( !Detector().webgl ) {
    var wrapper = document.createElement('div')
    wrapper.className = "errorMessage"
    var a = document.createElement('a')
    a.title = "You need WebGL and Pointer Lock (Chrome 23/Firefox 14) to play this game. Click here for more information."
    a.innerHTML = a.title
    a.href = "http://get.webgl.org"
    wrapper.appendChild(a)
    this.view.element = wrapper
    return true
  }
  return false
}

Game.prototype.onWindowResize = function() {
  this.view.resizeWindow(window.innerWidth, window.innerHeight)
}

Game.prototype.coerceVector3 = function(args) {
  if (!args) return false
  if (args[0] instanceof Array) return args[0]
  return [args[0], args[1], args[2]]
}

// # Physics/collision related methods
Game.prototype.control = function(target) {
  this.controlling = target
  return this.controls.target(target)
}

Game.prototype.potentialCollisionSet = function() {
  return [{ collide: this.collideTerrain.bind(this) }]
}

Game.prototype.collideTerrain = function(other, bbox, vec, resting) {
  var axes = ['x', 'y', 'z']
  var vec3 = [vec.x, vec.y, vec.z]
  this.collideVoxels(bbox, vec3, function hit(axis, tile, coords, dir, edge) {
    if (!tile) return
    if (Math.abs(vec3[axis]) < Math.abs(edge)) return
    vec3[axis] = vec[axes[axis]] = edge
    other.acceleration[axes[axis]] = 0
    resting[axes[axis]] = dir
    other.friction[axes[(axis + 1) % 3]] = other.friction[axes[(axis + 2) % 3]] = axis === 1 ? 0.5 : 1
    return true
  })
}

// # Three.js specific methods

Game.prototype.addStats = function() {
  stats = new Stats()
  stats.domElement.style.position  = 'absolute'
  stats.domElement.style.bottom  = '0px'
  document.body.appendChild( stats.domElement )
}

Game.prototype.addLights = function(scene) {
  var ambientLight, directionalLight
  ambientLight = new this.THREE.AmbientLight(0xcccccc)
  scene.add(ambientLight)
  var light	= new this.THREE.DirectionalLight( 0xffffff , 1)
  light.position.set( 1, 1, 0.5 ).normalize()
  scene.add( light )
}

// # Chunk related methods

Game.prototype.configureChunkLoading = function(opts) {
  var self = this
  if (!opts.generateChunks) return
  if (!opts.generate) {
    this.generate = function(x,y,z) {
      return x*x+y*y+z*z <= 15*15 ? 1 : 0 // sphere world
    }
  } else {
    this.generate = opts.generate
  }
  if (opts.generateVoxelChunk) {
    this.generateVoxelChunk = opts.generateVoxelChunk
  } else {
    this.generateVoxelChunk = function(low, high) {
      return voxel.generate(low, high, self.generate, self)
    }
  }
}

Game.prototype.worldWidth = function() {
  return this.chunkSize * 2 * this.chunkDistance
}

Game.prototype.chunkToWorld = function(pos) {
  return [
    pos[0] * this.chunkSize,
    pos[1] * this.chunkSize,
    pos[2] * this.chunkSize
  ]
}

Game.prototype.removeFarChunks = function(streamPosition) {
  var self = this
  streamPosition = streamPosition || this.playerPosition()
  var nearbyChunks = this.voxels.nearbyChunks(streamPosition, this.removeDistance).map(function(chunkPos) {
    return chunkPos.join('|')
  })
  Object.keys(self.voxels.chunks).map(function(chunkIndex) {
    if (nearbyChunks.indexOf(chunkIndex) > -1) return
    var chunk = self.voxels.meshes[chunkIndex]
    
    if (!chunk) return
    
    self.scene.remove(chunk[self.meshType])
    chunk[self.meshType].geometry.dispose()

    delete chunk.data
    delete chunk.geometry
    delete chunk.meshed
    delete chunk.surfaceMesh
    delete self.voxels.chunks[chunkIndex]
  })
  self.voxels.requestMissingChunks(streamPosition)
}

Game.prototype.addChunkToNextUpdate = function(chunk) {
  this.chunksNeedsUpdate[chunk.position.join('|')] = chunk
}

Game.prototype.updateDirtyChunks = function() {
  var self = this
  Object.keys(this.chunksNeedsUpdate).forEach(function showChunkAtIndex(chunkIndex) {
    var chunk = self.chunksNeedsUpdate[chunkIndex]
    self.showChunk(chunk)
  })
  this.chunksNeedsUpdate = {}
}

Game.prototype.getChunkAtPosition = function(pos) {
  var chunkID = this.voxels.chunkAtPosition(pos).join('|')
  var chunk = this.voxels.chunks[chunkID]
  return chunk
}

Game.prototype.showChunk = function(chunk) {
  var chunkIndex = chunk.position.join('|')
  var bounds = this.voxels.getBounds.apply(this.voxels, chunk.position)
  var scale = new this.THREE.Vector3(1, 1, 1)
  var mesh = voxelMesh(chunk, this.mesher, scale)
  this.voxels.chunks[chunkIndex] = chunk
  if (this.voxels.meshes[chunkIndex]) this.scene.remove(this.voxels.meshes[chunkIndex][this.meshType])
  this.voxels.meshes[chunkIndex] = mesh
  if (process.browser) {
    if (this.meshType === 'wireMesh') mesh.createWireMesh()
    else mesh.createSurfaceMesh(new this.THREE.MeshFaceMaterial(this.materials.get()))
    this.materials.paint(mesh.geometry)
  }
  mesh.setPosition(bounds[0][0], bounds[0][1], bounds[0][2])
  mesh.addToScene(this.scene)
  return mesh
}

// # Debugging methods

Game.prototype.addMarker = function(position) {
  var geometry = new this.THREE.SphereGeometry( 0.5, 10, 10 )
  var material = new this.THREE.MeshPhongMaterial( { color: 0xffffff, shading: this.THREE.FlatShading } )
  var mesh = new this.THREE.Mesh( geometry, material )
  mesh.position.copy(position)
  this.scene.add(mesh)
}

Game.prototype.addAABBMarker = function(aabb, color) {
  var geometry = new this.THREE.CubeGeometry(aabb.width(), aabb.height(), aabb.depth())
  var material = new this.THREE.MeshBasicMaterial({ color: color || 0xffffff, wireframe: true, transparent: true, opacity: 0.5, side: this.THREE.DoubleSide })
  var mesh = new this.THREE.Mesh(geometry, material)
  mesh.position.set(aabb.x0() + aabb.width() / 2, aabb.y0() + aabb.height() / 2, aabb.z0() + aabb.depth() / 2)
  this.scene.add(mesh)
  return mesh
}

Game.prototype.addVoxelMarker = function(x, y, z, color) {
  var bbox = aabb([x, y, z], [1, 1, 1])
  return this.addAABBMarker(bbox, color)
}

Game.prototype.pin = pin

// # Misc internal methods

Game.prototype.onControlChange = function(gained, stream) {
  this.paused = false

  if (!gained && !this.optout) {
    this.buttons.disable()
    return
  }

  this.buttons.enable()
  stream.pipe(this.controls.createWriteRotationStream())
}

Game.prototype.onControlOptOut = function() {
  this.optout = true
}

Game.prototype.onFire = function(state) {
  this.emit('fire', this.controlling, state)
}

Game.prototype.tick = function(delta) {
  for(var i = 0, len = this.items.length; i < len; ++i) {
    this.items[i].tick(delta)
  }
  
  if (this.materials) this.materials.tick()
  
  if (Object.keys(this.chunksNeedsUpdate).length > 0) this.updateDirtyChunks()
  
  this.emit('tick', delta)
  
  if (!this.controls) return
  var playerPos = this.playerPosition()
  this.spatial.emit('position', playerPos, playerPos)
}

Game.prototype.render = function(delta) {
  this.view.render(this.scene)
}

Game.prototype.initializeTimer = function(rate) {
  var self = this
  var accum = 0
  var now = 0
  var last = null
  var dt = 0
  var wholeTick
  
  self.frameUpdated = true
  self.interval = setInterval(timer, 0)
  return self.interval
  
  function timer() {
    if (self.paused) {
      last = Date.now()
      accum = 0
      return
    }
    now = Date.now()
    dt = now - (last || now)
    last = now
    accum += dt
    if (accum < rate) return
    wholeTick = ((accum / rate)|0)
    if (wholeTick <= 0) return
    
    wholeTick *= rate
    
    self.tick(wholeTick)
    accum -= wholeTick
    
    self.frameUpdated = true
  }
}

Game.prototype.initializeRendering = function() {
  var self = this

  if (!self.statsDisabled) self.addStats()

  window.addEventListener('resize', self.onWindowResize.bind(self), false)

  requestAnimationFrame(window).on('data', function(dt) {
    self.render(dt)
    stats.update()
  })
}

Game.prototype.defaultButtons = {
  'W': 'forward'
, 'A': 'left'
, 'S': 'backward'
, 'D': 'right'
, '<mouse 1>': 'fire'
, '<mouse 2>': 'firealt'
, '<space>': 'jump'
, '<control>': 'alt'
}

Game.prototype.initializeControls = function(opts) {
  // player control
  this.buttons = kb(document.body, opts.keybindings || this.defaultButtons)
  this.buttons.disable()
  this.optout = false
  this.interact = interact(this.view.element)
  this.interact
      .on('attain', this.onControlChange.bind(this, true))
      .on('release', this.onControlChange.bind(this, false))
      .on('opt-out', this.onControlOptOut.bind(this))
  this.hookupControls(this.buttons, opts)
}

Game.prototype.hookupControls = function(buttons, opts) {
  opts = opts || {}
  opts.controls = opts.controls || {}
  opts.controls.onfire = this.onFire.bind(this)
  this.controls = control(buttons, opts.controls)
  this.items.push(this.controls)
  this.controlling = null
}

Game.prototype.handleChunkGeneration = function() {
  var self = this
  this.voxels.on('missingChunk', function(chunkPos) {
    var chunk = self.voxels.generateChunk(chunkPos[0], chunkPos[1], chunkPos[2])
    if (process.browser) self.showChunk(chunk)
  })
  this.voxels.requestMissingChunks(this.worldOrigin)
}

// teardown methods
Game.prototype.destroy = function() {
  clearInterval(this.timer)
}
