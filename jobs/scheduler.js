// Legacy entrypoint kept for old deployment commands.
// The campaign sender now lives in campaignScheduler.js, which includes
// database-backed delivery locking to prevent duplicate live sends.
module.exports = require("./campaignScheduler");
