/* eslint-disable no-await-in-loop */
import logger from 'heroku-logger';
import { auth } from '../lib/hubAuth';
import { isLocal } from '../lib/amIlocal';
import checkQueue from '../lib/deployQueueCheck';
import { getDeployRequestSize } from '../lib/redisNormal';

(async () => {
    logger.debug('A one-off deploy consumer dyno is up!');
    await auth();

    while ((await getDeployRequestSize()) > 0) {
        await checkQueue();
    }

    if (!isLocal()) {
        // eslint-disable-next-line no-process-exit
        process.exit(0);
    }
})();
