const fetch = require("node-fetch");
const fs = require("fs");
const { query } = require("../../database/dbpromise");

function processOpenAi() {
  console.log("REQUIRED AI PLUGIN");
}

const openAiAddon = ["AI_BOT"];

module.exports = { processOpenAi, openAiAddon };
