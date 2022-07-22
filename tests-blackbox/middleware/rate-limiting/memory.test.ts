import config, { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import request from 'supertest';
import knex, { Knex } from 'knex';
import { spawn, ChildProcess } from 'child_process';
import { awaitDirectusConnection } from '@utils/await-connection';
import * as common from '@common/index';
import { sleep } from '@utils/sleep';

describe('Rate Limiting (memory)', () => {
	const databases = new Map<string, Knex>();
	const rateLimitedDirectus = {} as { [vendor: string]: ChildProcess };
	const rateLimiterPoints = 5;
	const rateLimiterPointsAuthenticated = 8;
	const rateLimiterDuration = 3;

	beforeAll(async () => {
		const promises = [];

		for (const vendor of vendors) {
			const newServerPort = Number(config.envs[vendor]!.PORT) + 200;
			databases.set(vendor, knex(config.knexConfig[vendor]!));

			config.envs[vendor]!.RATE_LIMITER_ENABLED = 'true';
			config.envs[vendor]!.RATE_LIMITER_STORE = 'memory';
			config.envs[vendor]!.RATE_LIMITER_POINTS = String(rateLimiterPoints);
			config.envs[vendor]!.RATE_LIMITER_POINTS_AUTHENTICATED = String(rateLimiterPointsAuthenticated);
			config.envs[vendor]!.RATE_LIMITER_DURATION = String(rateLimiterDuration);
			config.envs[vendor]!.PORT = String(newServerPort);

			const server = spawn('node', ['api/cli', 'start'], { env: config.envs[vendor] });
			rateLimitedDirectus[vendor] = server;

			let serverOutput = '';
			server.stdout.on('data', (data) => (serverOutput += data.toString()));
			server.on('exit', (code) => {
				if (code !== null) throw new Error(`Directus-${vendor} server failed: \n ${serverOutput}`);
			});
			promises.push(awaitDirectusConnection(newServerPort));
		}

		// Give the server some time to start
		await Promise.all(promises);
	}, 180000);

	afterAll(async () => {
		for (const [vendor, connection] of databases) {
			rateLimitedDirectus[vendor]!.kill();

			config.envs[vendor]!.PORT = String(Number(config.envs[vendor]!.PORT) - 200);
			config.envs[vendor]!.RATE_LIMITER_ENABLED = 'false';
			delete config.envs[vendor]!.RATE_LIMITER_STORE;
			delete config.envs[vendor]!.RATE_LIMITER_POINTS;
			delete config.envs[vendor]!.RATE_LIMITER_POINTS_AUTHENTICATED;
			delete config.envs[vendor]!.RATE_LIMITER_DURATION;

			await connection.destroy();
		}
	});

	describe('rate limits user with authentication', () => {
		it.each(vendors)('%s', async (vendor) => {
			for (let i = 0; i < rateLimiterPoints; i++) {
				await request(getUrl(vendor))
					.get(`/server/info`)
					.set('Authorization', `Bearer ${common.USER.APP_ACCESS.TOKEN}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);
			}

			// Reached user scoped rate limit
			await request(getUrl(vendor))
				.get(`/server/info`)
				.set('Authorization', `Bearer ${common.USER.APP_ACCESS.TOKEN}`)
				.expect('Content-Type', /application\/json/)
				.expect(429);
		});
	});

	describe('rate limits IP without authentication', () => {
		let needsToDelay = true;

		it.each(vendors)('%s', async (vendor) => {
			if (needsToDelay) {
				needsToDelay = false;
				await sleep(rateLimiterDuration * 1000);
			}

			for (let i = 0; i < rateLimiterPoints; i++) {
				await request(getUrl(vendor))
					.get(`/server/info`)
					.expect('Content-Type', /application\/json/)
					.expect(200);
			}

			await request(getUrl(vendor))
				.get(`/server/info`)
				.expect('Content-Type', /application\/json/)
				.expect(429);
		});
	});

	describe('rate limits IP with invalid authentication', () => {
		let needsToDelay = true;

		it.each(vendors)('%s', async (vendor) => {
			if (needsToDelay) {
				needsToDelay = false;
				await sleep(rateLimiterDuration * 1000);
			}

			for (let i = 0; i < rateLimiterPoints; i++) {
				await request(getUrl(vendor))
					.get(`/server/info`)
					.set('Authorization', 'Bearer FakeToken')
					.expect('Content-Type', /application\/json/)
					.expect(401);
			}

			await request(getUrl(vendor))
				.get(`/server/info`)
				.set('Authorization', 'Bearer FakeToken')
				.expect('Content-Type', /application\/json/)
				.expect(429);
		});
	});

	describe('authenticated requests increases IP rate limit', () => {
		let needsToDelay = true;

		it.each(vendors)('%s', async (vendor) => {
			if (needsToDelay) {
				needsToDelay = false;
				await sleep(rateLimiterDuration * 1000);
			}

			// Authenticated bypasses for a higher rate limit
			for (let i = 0; i < rateLimiterPoints - 1; i++) {
				await request(getUrl(vendor))
					.get(`/server/info`)
					.set('Authorization', `Bearer ${common.USER.APP_ACCESS.TOKEN}`)
					.expect('Content-Type', /application\/json/)
					.expect(200);
			}

			// Invalid authentication to increase rate limit value
			for (let i = 0; i < rateLimiterPointsAuthenticated - rateLimiterPoints; i++) {
				await request(getUrl(vendor))
					.get(`/server/info`)
					.set('Authorization', 'Bearer FakeToken')
					.expect('Content-Type', /application\/json/)
					.expect(401);
			}

			// Public access to hit IP rate limit
			await request(getUrl(vendor))
				.get(`/server/info`)
				.expect('Content-Type', /application\/json/)
				.expect(200);

			// IP rate limited for authenticated
			await request(getUrl(vendor))
				.get(`/server/info`)
				.set('Authorization', `Bearer ${common.USER.APP_ACCESS.TOKEN}`)
				.expect('Content-Type', /application\/json/)
				.expect(429);

			// IP rate limited for invalid authentication
			await request(getUrl(vendor))
				.get(`/server/info`)
				.set('Authorization', 'Bearer FakeToken')
				.expect('Content-Type', /application\/json/)
				.expect(429);

			// IP rate limited for public
			await request(getUrl(vendor))
				.get(`/server/info`)
				.expect('Content-Type', /application\/json/)
				.expect(429);
		});
	});
});
