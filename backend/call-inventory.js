/**
 * Standalone script to call FBA inventory summaries.
 * Uses env vars only - do not paste secrets into this file.
 *
 * Required env: LWA_ACCESS_TOKEN (or get via OAuth flow), AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 * Optional: AWS_REGION (default eu-west-1)
 */
require('dotenv').config();

const aws4 = require("aws4");
const https = require("https");

const accessToken = process.env.LWA_ACCESS_TOKEN;
const awsCreds = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

if (!accessToken || !awsCreds.accessKeyId || !awsCreds.secretAccessKey) {
  console.error(
    "Missing env: set LWA_ACCESS_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY"
  );
  process.exit(1);
}

const opts = {
  host: "sellingpartnerapi-eu.amazon.com",
  path: "/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=A1F83G8C2ARO7P&marketplaceIds=A1F83G8C2ARO7P",
  service: "execute-api",
  region: process.env.AWS_REGION || "eu-west-1",
  method: "GET",
  headers: {
    "x-amz-access-token": accessToken,
    "content-type": "application/json",
  },
};

aws4.sign(opts, awsCreds);

https
  .request(opts, (res) => {
    let data = "";
    console.log("STATUS:", res.statusCode);
    res.on("data", (chunk) => {
      data += chunk;
    });
    res.on("end", () => {
      console.log("Response:");
      console.log(data);
    });
  })
  .on("error", (err) => {
    console.log("ERROR:", err.message);
  })
  .end();
