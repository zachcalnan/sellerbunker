console.log("FILE IS RUNNING");

const aws4 = require("aws4");
const https = require("https");

// ===== YOUR TOKENS / KEYS =====
const accessToken = "Atza|IwEBIPjUx9Qfh1xaup5xkqF1k17lTPXq9aqSwZkqOp4OkPauRNzD9tQNzl0ugeOuXGYtDxHNpWKIUxFokru4RxSZ-QmvFI_5C4Iq1kVOSJDxWFjCeaIKIwxUlFDrQ7LV9JLGzkza7DdXde6YAyT28PgYyd2nRxGWarTfx0WOLeGZ5qDOBiqTPpH7DBjYJ3U0TISpMpiEurMiXxo5DD_nbz8dTXbJglxJzR0x_9rw3xwBnLWzZvQnt2J4PwN-U8pzNwrOf62TRseIkvFvBoU8TXEyQLvXg-M39cBuBmum7-kbwyq20WciRYq9VbRKgHU_7jpx8idIdWgoxleekL2hdSi4Futo_4OjAU6SBpz-CseoHJ1FiA";

const awsCreds = {
  accessKeyId: "PASTE_AWS_AAKIARY3GBIT3QDLAPP7W",
  secretAccessKey: "PASTE_AWS_SECRET_KEdY7R01uEeEUsap/tGBaDn8SCGzyjf7KUvrHmvQLbY",

};

// ===== REQUEST OPTIONS =====
const opts = {
  host: "sellingpartnerapi-eu.amazon.com",
 path: "/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=A1F83G8C2ARO7P&marketplaceIds=A1F83G8C2ARO7P",
  service: "execute-api",
  region: "eu-west-1",
  method: "GET",
  headers: {
    "x-amz-access-token": accessToken,
    "content-type": "application/json",
  },
};

// ===== SIGN REQUEST =====
aws4.sign(opts, awsCreds);

// ===== SEND REQUEST =====
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
