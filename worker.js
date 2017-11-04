
const mq = require('amqplib').connect(process.env.CLOUDAMQP_URL || 'amqp://localhost');
const exec = require('child-process-promise').exec;
const readline = require('readline');
const fs = require('fs');
const util = require('util');
const ua = require('universal-analytics');
const shellSanitize = require('./lib/shellSanitize');
const logger = require('heroku-logger');

const setTimeoutPromise = util.promisify(setTimeout);

logger.debug('I am a worker and I am up!');

//helper functions
function bufferKey(content, deployId) {
	const message = {
		deployId,
		content
	};
	return new Buffer(JSON.stringify(message));
}

function logResult(result){
	if (result){
		if (result.stderr){
			logger.error(result.stderr);
		}
		if (result.stdout){
			logger.debug(result.stdout);
		}
	}
}

let keypath;
// where will our cert live?
if (process.env.LOCAL_ONLY_KEY_PATH){
	// I'm fairly local
	logger.debug('loading local key');
	keypath = process.env.LOCAL_ONLY_KEY_PATH;
} else {
	// we're doing it in the cloud
	logger.debug('creating cloud key');
	fs.writeFileSync('/app/tmp/server.key', process.env.JWTKEY, 'utf8');
	keypath = '/app/tmp/server.key';
}

// const write = util.promisify(fs.writeFile);
// write('/app/tmp/server.key', process.env.JWTKEY, {
// 	encoding: "utf8",
// 	flag: "wx"
// })

// OK, we've got our environment prepared now.  Let's auth to our org and verify

exec(`sfdx force:auth:jwt:grant --clientid ${process.env.CONSUMERKEY} --username ${process.env.HUB_USERNAME} --jwtkeyfile ${keypath} --setdefaultdevhubusername -a deployBotHub`)
.then( (result) => {
	logResult(result);
	return exec('sfdx force:org:display -u deployBotHub');
})
.then((result) => {
	logResult(result);
	return exec('sfdx force:org:list');
})
.then( (result) => {
	logResult(result);
	return mq;
})
.then( (mqConn) => {
	const visitor = ua(process.env.UA_ID || 0);

	let ok = mqConn.createChannel();
	ok = ok.then((ch) => {
		ch.assertQueue('deploys', { durable: true });
		ch.assertQueue('deployMessages',{ durable: true });
		ch.prefetch(1);

		// this consumer eats deploys, creates local folders, and chops up the tasks into steps
		ch.consume('deploys', (msg) => {
			// do a whole bunch of stuff here!
			logger.debug(msg);
			const msgJSON = JSON.parse(msg.content.toString());
			logger.debug(msgJSON);
			logger.debug(msgJSON.deployId);
			logger.debug(msgJSON.template);
			visitor.event('Deploy Request', msgJSON.template).send();



			// clone repo into local fs
			exec(`cd tmp;git clone ${msgJSON.template}.git ${msgJSON.deployId}`)
				.then( (result) => {
					logResult(result);
					ch.sendToQueue('deployMessages', bufferKey(result.stdout, msgJSON.deployId));
					return exec(`cd tmp;cd ${msgJSON.deployId};ls`);
				})
				.then( (result) => {
					logResult(result);
					ch.sendToQueue('deployMessages', bufferKey('Cloning the repository', msgJSON.deployId));
					// ch.sendToQueue('deployMessages', bufferKey(result.stdout, msgJSON.deployId));
					// grab the deploy script from the repo
					logger.debug(`going to look in the directory tmp/${msgJSON.deployId}/orgInit.sh`);
					if (fs.existsSync(`tmp/${msgJSON.deployId}/orgInit.sh`)){
						let parsedLines = [];
						let noFail = true;
						const rl = readline.createInterface({
							input: fs.createReadStream(`tmp/${msgJSON.deployId}/orgInit.sh`),
							terminal: false
						}).on('line', (line) => {
							logger.debug(`Line: ${line}`);

							if (!shellSanitize(line)) {
								ch.sendToQueue('deployMessages', bufferKey(`Commands with metacharacters cannot be executed.  Put each command on a separate line.  Your command: ${line}`, msgJSON.deployId));
								noFail = false;
								rl.close();
								ch.ack(msg);
								visitor.event('Repo Problems', 'line with semicolons', msgJSON.template).send();
							} else if (!line){
								logger.debug('empty line');
							} else if (line.includes('-u ')) {
								logger.debug('found a -u in a command line');
								ch.sendToQueue('deployMessages', bufferKey(`Commands can't contain -u...you can only execute commands against the default project the deployer creates--this is a multitenant sfdx deployer.  Your command: ${line}`, msgJSON.deployId));
								noFail = false;
								rl.close();
								ch.ack(msg);
								visitor.event('Repo Problems', 'line with -u', msgJSON.template).send();
							} else if (!line.startsWith('sfdx') && !line.startsWith('#')){
								ch.sendToQueue('deployMessages', bufferKey(`Commands must start with sfdx or be comments (security, yo!).  Your command: ${line}`, msgJSON.deployId));
								noFail = false;
								rl.close();
								ch.ack(msg);
								visitor.event('Repo Problems', 'non-sfdx line', msgJSON.template).send();
							} else {
								logger.debug('line pushed');
								parsedLines.push(`cd tmp;cd ${msgJSON.deployId};${line}`);
							}
						}).on('close', () => {
							// you have all the parsed lines
							logger.debug('in the close event');
							logger.debug(parsedLines);
							if (noFail){
								logger.debug('no fail is true');
								async function executeLines(lines) {
									for(let line of lines) {
										let localLine = line;
										logger.debug(localLine);
										// corrections and improvements for individual commands
										if (localLine.includes('sfdx force:org:open') && !localLine.includes(' -r')) {
											localLine = localLine + ' -r --json';
											logger.debug('org open command : ' + localLine);
											visitor.event('sfdx event', 'org open', msgJSON.template).send();
										}
										if (localLine.includes('sfdx force:user:password') && !localLine.includes(' --json')) {
											localLine = localLine + ' --json';
											logger.debug('org password command : ' + localLine);
											visitor.event('sfdx event', 'password gen', msgJSON.template).send();
										}
										if (localLine.includes('sfdx force:org:create') && !localLine.includes(' --json')) {
											localLine = localLine + ' --json';
											logger.debug('org create command : ' + localLine);
											visitor.event('sfdx event', 'org creation', msgJSON.template).send();
										}
										try {
											var lineResult = await exec(localLine);
											logger.debug(lineResult.stderr);
											if (lineResult.stdout){
												logger.debug(lineResult.stdout);
												ch.sendToQueue('deployMessages', bufferKey(lineResult.stdout, msgJSON.deployId));
											}
											if (lineResult.stderr){
												logger.error(lineResult.stderr);
												ch.sendToQueue('deployMessages', bufferKey(lineResult.stderr, msgJSON.deployId));
												visitor.event('deploy error', msgJSON.template, lineResult.stderr).send();
											}
										} catch (err) {
											console.error('Error: ', err);
											ch.sendToQueue('deployMessages', bufferKey(`Error: ${err}`, msgJSON.deployId));
											visitor.event('deploy error', msgJSON.template, err).send();

										}
									}
								};
								executeLines(parsedLines)
								.then( () => {
									ch.sendToQueue('deployMessages', bufferKey('ALLDONE', msgJSON.deployId));
									visitor.event('deploy complete', msgJSON.template).send();
									ch.ack(msg);

									// clean up after a minute
									return setTimeoutPromise(1000 * 60, 'foobar');
								}).then((value) => {
									exec(`cd tmp;rm -rf ${msgJSON.deployId}`);
								}).then((result) => {
									logResult(result);
								});
							} else {
								// deploy failed
								setTimeoutPromise(1000 * 60, 'foobar')
								.then((value) => {
									exec(`cd tmp;rm -rf ${msgJSON.deployId}`);
								}).then((result) => {
									logResult(result);
								});
							}
						}); // end of on.close event
					} else {
						ch.sendToQueue('deployMessages', bufferKey('There is no orgInit.sh', msgJSON.deployId));
						visitor.event('Repo Problems', 'no orgInit.sh', msgJSON.template).send();
					}
				})
				.catch( err => {
					logger.error('Error: ', err);
					ch.ack(msg);
				});

		}, { noAck: false });
	});
	return ok;

})
.catch( (reason) => {
	logger.error(reason);
});









