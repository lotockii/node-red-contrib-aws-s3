module.exports = function(RED) {
    "use strict";
    const fs = require('fs');
    const { minimatch } = require('minimatch');
    const { PassThrough } = require('stream');
    const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsCommand } = require("@aws-sdk/client-s3");
    const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

    function configureS3(node, msg, getValue) {
        // Получаем параметры из конфигурации или контекста
        const awsConfig = node.awsConfig;
        const accessKeyId = getValue(awsConfig.accessKeyId, awsConfig.accessKeyIdType, msg);
        const secretAccessKey = getValue(awsConfig.secretAccessKey, awsConfig.secretAccessKeyType, msg);
        const useIamRole = awsConfig.useIamRole;
        const endpoint = getValue(awsConfig.endpoint, awsConfig.endpointType || 'str', msg);
        const forcePathStyle = awsConfig.forcepathstyle;
        const skipTlsVerify = awsConfig.skiptlsverify;
        const regionValue = getValue(awsConfig.region, awsConfig.regionType || 'str', msg) || awsConfig.region;
        if (!regionValue) {
            throw new Error('Region is missing in AWS S3 configuration');
        }
        const options = { region: regionValue };
        if (endpoint) {
            options.endpoint = endpoint;
            options.forcePathStyle = forcePathStyle || false;
            options.tls = !skipTlsVerify;
        }
        if (useIamRole) {
            if ('credentials' in options) {
                delete options.credentials;
            }
        } else {
            if (accessKeyId && secretAccessKey) {
                options.credentials = {
                    accessKeyId,
                    secretAccessKey
                };
            }
        }
        // Диагностика
        return new S3Client(options);
    }

    function AWSNode(n) {
        RED.nodes.createNode(this, n);
        this.endpoint = n.endpoint;
        this.forcepathstyle = n.forcepathstyle;
        this.skiptlsverify = n.skiptlsverify;
        this.region = n.region;
        this.regionType = n.regionType;
        this.accessKeyId = n.accessKeyId;
        this.accessKeyIdType = n.accessKeyIdType;
        this.secretAccessKey = n.secretAccessKey;
        this.secretAccessKeyType = n.secretAccessKeyType;
        this.useIamRole = n.useIamRole;
        this.endpointType = n.endpointType;
    }

    RED.nodes.registerType("aws-s3-config", AWSNode, {
        credentials: {
            accesskeyid: { type: "text" },
            secretaccesskey: { type: "password" }
        }
    });

    // Amazon S3 In Node
    function AmazonS3InNode(n) {
        RED.nodes.createNode(this, n);
        this.awsConfig = RED.nodes.getNode(n.aws);
        this.bucket = n.bucket;
        this.bucketType = n.bucketType || 'str';
        this.filepattern = n.filepattern || "";
        this.pollingInterval = n.pollingInterval || 900; // По умолчанию 15 минут
        const node = this;

        /**
         * Get value from different input types
         * @param {string} value - Value to get
         * @param {string} type - Type of value (str, msg, flow, global, env)
         * @param {Object} msg - Message object
         * @returns {string} Retrieved value
         */
        function getValue(value, type, msg) {
            if (!value) return null;
            try {
                let result;
                switch (type) {
                    case 'msg':
                        result = RED.util.getMessageProperty(msg, value);
                        break;
                    case 'flow':
                        result = node.context().flow.get(value);
                        break;
                    case 'global':
                        result = node.context().global.get(value);
                        break;
                    case 'env':
                        result = process.env[value];
                        break;
                    default:
                        result = value;
                }
                return result;
            } catch (err) {
                throw new Error(`Failed to get value for type: ${type}, value: ${value}. Error: ${err.message}`);
            }
        }

        function getBucket(msg) {
            return msg.bucket || getValue(node.bucket, node.bucketType, msg);
        }

        node.status({ fill: "blue", shape: "dot", text: "aws.status.initializing" });

        const contents = [];

        node.listAllObjects = async function (s3, params, contents, cb) {
            try {
                const command = new ListObjectsCommand(params);
                const data = await s3.send(command);

                contents = contents.concat(data.Contents || []);
                if (data.IsTruncated) {
                    params.Marker = contents[contents.length - 1].Key;
                    await node.listAllObjects(s3, params, contents, cb);
                } else {
                    cb(null, contents);
                }
            } catch (err) {
                cb(err, contents);
            }
        };

        // Инициализация при старте с задержкой 30 секунд
        let interval = null;
        
        const initializePolling = () => {
            const bucketValue = getBucket({});
            const s3 = configureS3(node, {}, getValue);

            node.listAllObjects(s3, { Bucket: bucketValue }, contents, function (err, data) {
                if (err) {
                    node.error(RED._("aws.error.failed-to-fetch", { err: err }));
                    node.status({ fill: "red", shape: "ring", text: "aws.status.error" });
                    return;
                }
                const filteredContents = node.filterContents(data);
                node.state = filteredContents.map(e => e.Key);
                node.status({ fill: "green", shape: "dot", text: `Monitoring ${node.state.length} files` });

                // Настраиваемый интервал polling (в секундах), преобразуем в миллисекунды
                const pollingInterval = (n.pollingInterval || 900) * 1000;
                
                interval = setInterval(() => {
                    node.emit("input", {});
                }, pollingInterval);
            });
        };

        // Первый запуск через 30 секунд после деплоя
        node.status({ fill: "yellow", shape: "ring", text: "Waiting 30s before first check..." });
        const initTimeout = setTimeout(() => {
            node.status({ fill: "blue", shape: "dot", text: "aws.status.initializing" });
            initializePolling();
        }, 30000);

        node.on("input", async (msg) => {
            node.status({ fill: "blue", shape: "dot", text: "aws.status.checking-for-changes" });
            const contents = [];
            try {
                const bucketValue = getBucket(msg);
                const s3 = configureS3(node, msg, getValue);
                
                await node.listAllObjects(s3, { Bucket: bucketValue }, contents, (err, data) => {
                    if (err) {
                        throw err;
                    }
                    const newContents = node.filterContents(data);
                    const seen = {};
                    msg.bucket = bucketValue;
                    node.state.forEach(e => { seen[e] = true; });

                    newContents.forEach(content => {
                        const file = content.Key;
                        if (seen[file]) {
                            delete seen[file];
                        } else {
                            const newMessage = RED.util.cloneMessage(msg);
                            newMessage.payload = file;
                            newMessage.file = file.substring(file.lastIndexOf('/') + 1);
                            newMessage.event = 'add';
                            newMessage.data = content;
                            node.send(newMessage);
                        }
                    });

                    Object.keys(seen).forEach(f => {
                        const newMessage = RED.util.cloneMessage(msg);
                        newMessage.payload = f;
                        newMessage.file = f.substring(f.lastIndexOf('/') + 1);
                        newMessage.event = 'delete';
                        node.send(newMessage);
                    });

                    node.state = newContents.map(e => e.Key);
                });
            } catch (err) {
                node.error(RED._("aws.error.failed-to-fetch", { err: err }), msg);
            }

            node.status({ fill: "green", shape: "dot", text: `Monitoring ${node.state ? node.state.length : 0} files` });
        });

        node.on("close", () => {
            if (interval !== null) {
                clearInterval(interval);
            }
            if (initTimeout) {
                clearTimeout(initTimeout);
            }
        });
    }

    RED.nodes.registerType("aws-s3-in", AmazonS3InNode);

    AmazonS3InNode.prototype.filterContents = function (contents) {
        return this.filepattern ? contents.filter(e => minimatch(e.Key, this.filepattern)) : contents;
    };

    // Amazon S3 Query Node
    async function handleInput(node, msg, s3) {
        try {
            // Получаем значения bucket динамически
            const bucket = msg.bucket || getValue(node.bucket, node.bucketType, msg);
            const filename = node.filename || msg.filename;

            if (!bucket) {
                node.error("No S3 bucket specified", msg);
                return;
            }

            if (!filename) {
                node.error("No S3 file key (filename) specified", msg);
                return;
            }

            node.status({ fill: "blue", shape: "dot", text: "aws.status.downloading" });

            const command = new GetObjectCommand({
                Bucket: bucket,
                Key: filename
            });

            const data = await s3.send(command);

            const stream = data.Body;
            let chunks = [];

            stream.on('data', (chunk) => {
                chunks.push(chunk);
            });
            
            stream.on('end', () => {
                const buffer = Buffer.concat(chunks);
                if (node.returnBuffer === 'yes'){
                    msg.payload = buffer;
                }else {
                    msg.payload = buffer.toString();
                }
                node.status({}); // Сбрасываем статус при успешном выполнении
                node.send(msg);
            });

            stream.on('error', (err) => {
                node.error(`Error reading S3 object: ${err.message}`, msg);
                node.status({ fill: "red", shape: "ring", text: "aws.status.error" });
            });
        } catch (err) {
            node.error(`Error downloading object: ${err.message}`, msg);
            node.status({ fill: "red", shape: "ring", text: "aws.status.error" });
        }
    }

    async function generateSignedUrl(s3, bucket, filename, expiresIn) {
        try {
            const command = new GetObjectCommand({
                Bucket: bucket,
                Key: filename
            });
            const signedUrl = await getSignedUrl(s3, command, { expiresIn });
            return signedUrl;
        } catch (err) {
            throw new Error(`Error generating signed URL: ${err.message}`);
        }
    }

    function AmazonS3QueryNode(n) {
        RED.nodes.createNode(this, n);
        this.awsConfig = RED.nodes.getNode(n.aws);
        this.bucket = n.bucket;
        this.bucketType = n.bucketType || 'str';
        this.filename = n.filename || "";
        this.createSignedUrl = n.createSignedUrl || 'no';
        this.returnBuffer = n.returnBuffer || 'yes';
        // Преобразуем urlExpiration в число, гарантируем минимум 1 секунду
        const expiration = parseInt(n.urlExpiration, 10);
        this.urlExpiration = (!isNaN(expiration) && expiration > 0) ? expiration : 60;
        const node = this;

        /**
         * Get value from different input types
         * @param {string} value - Value to get
         * @param {string} type - Type of value (str, msg, flow, global, env)
         * @param {Object} msg - Message object
         * @returns {string} Retrieved value
         */
        function getValue(value, type, msg) {
            if (!value) return null;
            try {
                let result;
                switch (type) {
                    case 'msg':
                        result = RED.util.getMessageProperty(msg, value);
                        break;
                    case 'flow':
                        result = node.context().flow.get(value);
                        break;
                    case 'global':
                        result = node.context().global.get(value);
                        break;
                    case 'env':
                        result = process.env[value];
                        break;
                    default:
                        result = value;
                }
                return result;
            } catch (err) {
                throw new Error(`Failed to get value for type: ${type}, value: ${value}. Error: ${err.message}`);
            }
        }

        function getBucket(msg) {
            return msg.bucket || getValue(node.bucket, node.bucketType, msg);
        }

        node.on("input", async (msg) => {
            const bucket = getBucket(msg);
            const filename = node.filename || msg.filename;

            if (!bucket) {
                node.error(RED._("aws.error.no-bucket-specified"), msg);
                return;
            }

            if (!filename) {
                node.error(RED._("aws.error.no-filename-specified"), msg);
                return;
            }

            msg.bucket = bucket;
            msg.filename = filename;

            const s3 = configureS3(node, msg, getValue);

            if (node.createSignedUrl === 'yes') {
                try {
                    node.status({ fill: "blue", shape: "dot", text: "aws.status.generating-url" });
                    const signedUrl = await generateSignedUrl(s3, bucket, filename, node.urlExpiration);
                    msg.payload = signedUrl;
                    node.status({}); // Сбрасываем статус при успешном выполнении
                    node.send(msg);
                } catch (err) {
                    node.error(`Error generating signed URL: ${err.message}`, msg);
                    node.status({ fill: "red", shape: "ring", text: "aws.status.error" });
                }
            } else {
                await handleInput(node, msg, s3);
            }
        });
    }

    RED.nodes.registerType('aws-s3-handle', AmazonS3QueryNode);

    // Amazon S3 Out Node
    function AmazonS3OutNode(n) {
        RED.nodes.createNode(this, n);
        this.awsConfig = RED.nodes.getNode(n.aws);
        this.bucket = n.bucket;
        this.bucketType = n.bucketType || 'str';
        this.filename = n.filename || "";
        this.localFilename = n.localFilename || "";
        this.sendOutput = n.sendOutput === true || n.sendOutput === "true";
        const node = this;

        /**
         * Get value from different input types
         * @param {string} value - Value to get
         * @param {string} type - Type of value (str, msg, flow, global, env)
         * @param {Object} msg - Message object
         * @returns {string} Retrieved value
         */
        function getValue(value, type, msg) {
            if (!value) return null;
            try {
                let result;
                switch (type) {
                    case 'msg':
                        result = RED.util.getMessageProperty(msg, value);
                        break;
                    case 'flow':
                        result = node.context().flow.get(value);
                        break;
                    case 'global':
                        result = node.context().global.get(value);
                        break;
                    case 'env':
                        result = process.env[value];
                        break;
                    default:
                        result = value;
                }
                return result;
            } catch (err) {
                throw new Error(`Failed to get value for type: ${type}, value: ${value}. Error: ${err.message}`);
            }
        }

        node.on("input", async (msg) => {
            const s3 = configureS3(node, msg, getValue);
            const bucketFromMsg = msg.bucket;
            const bucketFromNode = getValue(node.bucket, node.bucketType, msg);
            const bucket = bucketFromMsg || bucketFromNode;
            if (!bucket) {
                node.error(RED._("aws.error.no-bucket-specified"), msg);
                return;
            }

            const filename = node.filename || msg.filename;
            if (!filename) {
                node.error(RED._("aws.error.no-filename-specified"), msg);
                return;
            }

            const localFilename = node.localFilename || msg.localFilename;

            const contentType = msg.contentType || 'application/octet-stream';

            const uploadParams = {
                Bucket: bucket,
                Key: filename,
                ContentType: contentType
            };

            if (localFilename) {
                node.status({ fill: "blue", shape: "dot", text: "aws.status.uploading" });
                const stream = fs.createReadStream(localFilename);
                uploadParams.Body = stream;

                try {
                    const command = new PutObjectCommand(uploadParams);
                    const data = await s3.send(command);
                    msg.s3Response = data;
                    if (node.sendOutput) node.send(msg);
                    node.status({});
                } catch (err) {
                    node.error(`Error uploading file: ${err.message}`, msg);
                    node.status({ fill: "red", shape: "ring", text: "aws.status.failed" });
                }
            } else if (msg.payload !== undefined) {
                node.status({ fill: "blue", shape: "dot", text: "aws.status.uploading" });
                uploadParams.Body = RED.util.ensureBuffer(msg.payload);

                try {
                    const command = new PutObjectCommand(uploadParams);
                    const data = await s3.send(command);
                    msg.s3Response = data;
                    if (node.sendOutput) node.send(msg);
                    node.status({});
                } catch (err) {
                    node.error(`Error uploading file: ${err.message}`, msg);
                    node.status({ fill: "red", shape: "ring", text: "aws.status.failed" });
                }
            }
        });
    }

    RED.nodes.registerType("aws-s3-out", AmazonS3OutNode);
};