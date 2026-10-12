const AWS = require('aws-sdk');

const PART_SIZE = 64 * 1024 * 1024;
const QUEUE_SIZE = 4;

class S3Storage {
  constructor(config, log) {
    this.bucket = config.s3_bucket;
    this.log = log;
    const cfg = {};
    if (config.s3_endpoint != '') {
      cfg['endpoint'] = config.s3_endpoint;
    }
    cfg['s3ForcePathStyle'] = config.s3_use_path_style_endpoint;
    AWS.config.update(cfg);
    this.s3 = new AWS.S3();
  }

  async length(id) {
    const result = await this.s3
      .headObject({ Bucket: this.bucket, Key: id })
      .promise();
    return Number(result.ContentLength);
  }

  getStream(id) {
    return this.s3
      .getObject({ Bucket: this.bucket, Key: id })
      .createReadStream();
  }

  set(id, file) {
    // aws-sdk v2 allows at most 10000 parts; the default 5MB part size would
    // cap uploads at ~50GB. 64MiB parts allow ~625GiB (> 300GiB large mode).
    // Memory use is roughly partSize * queueSize (~256MiB).
    const upload = this.s3.upload(
      {
        Bucket: this.bucket,
        Key: id,
        Body: file
      },
      { partSize: PART_SIZE, queueSize: QUEUE_SIZE }
    );
    file.on('error', () => upload.abort());
    return upload.promise();
  }

  del(id) {
    return this.s3.deleteObject({ Bucket: this.bucket, Key: id }).promise();
  }

  // Lists all objects (paged). Resolves to [{key, size, lastModified}]
  async list() {
    const items = [];
    let token;
    do {
      const params = { Bucket: this.bucket };
      if (token) {
        params.ContinuationToken = token;
      }
      const res = await this.s3.listObjectsV2(params).promise();
      for (const o of res.Contents || []) {
        items.push({
          key: o.Key,
          size: Number(o.Size),
          lastModified: o.LastModified
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return items;
  }

  ping() {
    return this.s3.headBucket({ Bucket: this.bucket }).promise();
  }
}

module.exports = S3Storage;
