import model from './gameTidy.large.model.json' with { type: 'json' }

/** Clean-up weights for GAME's larger model. Kept in a module of their own so they load only when that model is used. */
export default model
