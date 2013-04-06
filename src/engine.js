var version = "@VERSION";

var 
	// Prototype for all es:
	ESProto = {};


// Function that creates a new es.
// This function will be exported to the global object.
var esEngine = function() {
		
		// #### Create the "es" that will be returned:
		var es = Object_create( ESProto );
		
		
		// #### Create structures that will manage the entities
		// Each entity is a pointer to a BitArray in a big ArrayOfBitArray.
		// Each bit of the BitArray tells which components the entity has.
		var 
			// Contains all entities and which component they have:
			allEntities = Object_preventExtensions( ArrayOfBitArray( INTEGERBITS ) ),
			allEntities_bitsSet = allEntities._bitsSet,
			// Manages which entities can be reused.
			// I use a simple hack in the underlying bitArray
			// of each entity: available entities returns that
			// they possess -1 components.
			entitiesManager = BufferedIndexRecycler( allEntities, {
				bufferSize: 128,
				isAvailable: function( index ) {
					return allEntities_bitsSet[ index ] === -1;
				},
				expandArray: function( expandAmount ) {
					return allEntities.length += expandAmount;
				},
				// When there is no more entity to be reused, creates 16 new
				// entities at the same time.
				expandAmount: 32,
				// When there are unused entities at the end, shrink the array
				// by 64, but not before there are 512 unused at the end.
				maxTrailingAvailable: 512,
				reduceAmount: 64,
				onAcquired: function( index ) {
					allEntities_bitsSet[ index ] = 0;
				},
				onReleased: function( index ) {
					if( allEntities_bitsSet[ index ] > 0 ) throw "That entity still has components";
					allEntities_bitsSet[ index ] = -1;
				}
			}),
			// {es,bag}.newEntity( component... )
			newEntity = function() {
				var args = arguments,
					length = args.length,
					entity = entitiesManager.acquire();
				
				if( length === 0 ) throw "An entity cannot exist without a component";
				
				for( var i = 0; i < length; i++ ) {
					args[i].$addTo( entity );
				}
				return entity;
			},
			// {es,bag}.disposeEntity( entity... )
			disposeEntity = function() {
				var args = arguments,
					argsLength = args.length;
				
				for( var i = 0; i < argsLength; i++ ) {
					disposeOneEntity( args[i] );
				}
			},
			// Internally used, instead of disposeEntity(),
			// because most of the time we dispose entities one by one.
			disposeOneEntity = function( entity ) {
				var bagsLength = allBagsArray.length;
				
				// Do this in advance, to prevent bags from processing the entity
				// each time a component will be removed from the entity.
				for( var j = 0; j < bagsLength; j++ ) {
					allBagsArray[j].removeOne( entity );
				}
				// Dispose all components of the entity:
				entitiesManager.eachSet( entity, disposeComponent );
			},
			// Internal. Disposes entities that have no more component.
			disposeOneEmptyEntity = function( entity ) {
				var bagsLength = allBagsArray.length;
				
				// Remove the entity from all the bags:
				for( var j = 0; j < bagsLength; j++ ) {
					allBagsArray[j].removeOne( entity );
				}
				// The entity can be reused now:
				entitiesManager.release( entity );
			},
			// Internal. Disposes a component.
			disposeComponent = function( componentId, entity ) {
				allComponents[ componentId ][ entity ].$dispose();
			};
			
			// Acquire and discard the entity with id 0,
			// because entity ids must start at 1
			entitiesManager.acquire();
		
		
		// #### Create structures for managing components.
		// Each type of component has an id, the creatorId.
		// This id is used to efficiently store and retrieve components from arrays and maps.
		// Prototype chain: component -> proto (1 for each componentCreator) -> componentDef.helpers -> ComponentProto
		var 
			allCreators = RecycledIndexedNamedList({
				onArrayExpanded: function( length ) {
					if( length > allEntities.size ) {
						allEntities.size = Math.ceil( length / INTEGERBITS ) * INTEGERBITS;
					}
				},
				onArrayReduced: function( length ) {
					// Removing creators is not in the API.
				}
			}),
			allCreatorsArray = allCreators.array,
			allCreators_byName = allCreators.names,
			allCreators_byId = allCreators.map,
			allComponents = [],
			componentCreator = function( cDef ) {
				if( isString( cDef ) ) {
					if( !esEngine_cDefs[ cDef ] ) throw "No ComponentDef found with name: " + cDef;
					cDef = esEngine_cDefs[ cDef ];
				}
				if( !( isPrototypeOf( ComponentDefProto, cDef ) ) ) throw "cDef is not a valid ComponentDef";
				
				var name = cDef.name,
					creator = allCreators_byName[ name ];
				
				if( !creator ) {
					
					var set = cDef._set,
						constr = function() {
							var component = Object_create( proto );
							set( component );
							component.$e = 0;
							Object_defineProperty( component, "$e", defPropsUnenumerable );
							Object_preventExtensions( component );
							return component;
						},
						onAcquired = noopFunc,
						onReleased = function( component ) {
							if( component.$e !== 0 ) component.$remove();
						};
					
					var poolDef = poolFactory( constr, cDef.init, onAcquired, onReleased, cDef._reset ),
						proto = compactCreate( cDef.helpers , defPropsUnenumerableUnwriteable, {
							$creator: creator = poolDef.acquirer,
							$addTo: function( entity ) {
								if( !(entity > 0) ) throw "Cannot add to no entity: " + name;
								if( this.$e !== 0 ) throw "This component was already added to an entity: " + name;
								if( components[ entity ] ) throw "This entity already has a component of type: " + name;
								if( allEntities.set( entity, creatorId ) <= 0) throw "The entity was disposed";
								this.$e = entity;
								components[ entity ] = this;
							},
							$remove: function() {
								var entity = this.$e;
								if( entity === 0 ) throw "This component was not added to an entity: " + name;
								delete components[ entity ];
								this.$e = 0;
								if( allEntities.unset( entity, creatorId ) === 0 ) {
									disposeOneEmptyEntity( entity );
								}
							},
							$dispose: poolDef.disposer,
						});
					
					// Store the new creator and implicitly give it an id:
					allCreators.add( name, creator );
					
					var creatorId = creator._id,
						components = allComponents[ creatorId ] = {};
					
					compactDefine( creator, defPropsUnenumerableUnwriteable, {
						_id: creatorId
					}, defPropsUnwriteable, {
						def: cDef,
						getFor: function( entity ) {
							return components[ entity ] || null;
						},
						_pool: poolDef.pool
					});
				}
				
				return creator;
			};
		
		
		// #### Create structures for managing bags.
		// All bags are kept in an unordered dense array for quick access.
		// Prototype chain: bag -> BagESProto -> BagProto
		var allBags = RecycledIndexedList(),
			allBagsArray = allBags.array,
			// Methods available on all bags and on es.entities:
			BagESProto = compactCreate( BagProto, defProps, {
				// Automatically adds the new entity to itself:
				newEntity: function() {
					var entity = newEntity.apply( es, arguments );
					this._e[ entity ] = true;
					return entity;
				},
				disposeEntity: disposeEntity,
				dispose: function() {
					this.clear();
					allBags.remove( this );
				}
			}),
			// Constructor for all bags (except es.entities):
			bag = function( name ) {
				if( !isString( name ) && name !== undefined ) throw "Bag name must be a string (or undefined): " + name;
				
				var bag = compactCreate( BagESProto, defProps, {
					name: name
				}, defPropsUnenumerable, {
					_id: -1	// Will be set in allBags.add()
				}, defPropsUnenumerableUnwriteable, {
					// Map of contained entities:
					_e: {},
					_es: es
				});
				
				allBags.add( bag );
				
				return bag;
			};
		
		// #### Create the special bag es.entities
		// It doesn't need to store it's own entities (no ._e property).
		// Many methods are deactivated because they don't make sense.
		// Prototype chain: entities -> BagESProto -> BagProto
		var entities = compactCreate( BagESProto, defProps, {
				disposeEntitiesFrom: function() {},
				keepEntities: function() {},
				discardEntities: function() {},
				clearEntities: function() {}
			}, defPropsUnenumerableUnwriteable, {
				_es: es,
				name: "*"
			});
		// All these methods will throw if called:
		entities.add =
		entities.addOne =
		entities.addFrom =
		entities.remove =
		entities.removeOne =
		entities.removeFrom =
		entities.keep =
		entities.discard =
		entities.clear =
		entities.dispose = unsupportedOperationFunc;
		
		
		// #### Return the es, with all needed properties exposed:
		return compactDefine( es, defPropsUnwriteable, {
				componentCreator: componentCreator,
				entities: entities,
				bag: bag,
				newEntity: newEntity,
				disposeEntity: disposeEntity
			});
	};
