node-red-contrib-aws-s3
=================

Edited by: Andrii Lototskyi

A <a href="http://nodered.org" target="_new">Node-RED</a> node to watch, send
and receive files from an Amazon S3 bucket.

This version of the module uses the latest version of the AWS SDK v3

Install
-------

Run the following command in the root directory of your Node-RED install

        npm install node-red-contrib-aws-s3

Usage
-----

### Amazon S3 watch node

Watches for file events on an Amazon S3 bucket. By default all
file events are reported, but the filename pattern can be supplied
to limit the events to files which have full filenames that match
the glob pattern. The event messages consist of the full filename
in `msg.payload` property, the filename in `msg.file`,
the event type in `msg.event`.

### Amazon S3 input node

Downloads content from an Amazon S3 bucket. The bucket name can be specified in
the node **bucket** property or in the `msg.bucket` property.
The name of the file to download is taken from the node <b>filename</b> property
or the `msg.filename` property. The downloaded content is sent as `msg.payload`
property.
If you want to get response like buffer you can choose property **Response Buffer** 
in node's settings. Also you can get temporary link to download file, for this option 
you need choose property **Public Link** with value <b>yes</b> and you can set time 
for temporary link in seconds (default 60 sec). If the download fails `msg.error` will contain an error object.


### Amazon S3 out node.

Uploads content to an Amazon S3 bucket. The bucket name can be specified in the
node <b>bucket</b> property or in the `msg.bucket` property. The filename on
Amazon S3 is taken from the node <b>filename</b> property or the
`msg.filename` property. The content is taken from either the node
<b>localFilename</b> property, the `msg.localFilename` property or
the `msg.payload` property. 
Also you can set content type of your file, for this you need send param `msg.contentType`.