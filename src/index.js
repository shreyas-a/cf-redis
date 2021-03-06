const { promisify } = require('util');
const Redis = require('redis');
const Contentful = require('contentful');

/**
 * A recursive function to extract meaningful
 * information from Redis.
 * @param {object} data
 * @param {string} locale
 * @returns {object}
 */
const extract = (data, locale) => {
  if (data && data.fields) {
    const details = {};
    const { fields } = data;
    Object.keys(fields).forEach(fieldKey => {
      if (fields[fieldKey] && fields[fieldKey][locale] instanceof Array) {
        details[fieldKey] = fields[fieldKey][locale].map(innerData =>
          extract(innerData, locale)
        );
      } else if (
        fields[fieldKey] &&
        fields[fieldKey][locale] instanceof Object &&
        fields[fieldKey][locale].fields
      ) {
        details[fieldKey] = extract(fields[fieldKey][locale], locale);
      } else {
        details[fieldKey] =
          (fields[fieldKey] && fields[fieldKey][locale]) || '';
      }
    });

    // Removing the unwanted information
    return {
      id: data.sys.id,
      ...(data.sys.contentType &&
        data.sys.contentType.sys &&
        data.sys.contentType.sys.id && { type: data.sys.contentType.sys.id }),
      createdAt: data.sys.createdAt,
      updatedAt: data.sys.updatedAt,
      ...details,
    };
  } else if (typeof data === 'string' || typeof data === 'number') {
    return data;
  }

  return undefined;
};

class RedisContentful {
  constructor({ redis, contentful }) {
    this.redisClient = Redis.createClient({
      ...(redis &&
        redis.host &&
        redis.port && { host: redis.host, port: redis.port }),
    });
    this.redisClient.select((redis && redis.database) || 0);

    this.cfClient = Contentful.createClient({
      space: contentful.space,
      accessToken: contentful.accessToken,
      environment: contentful.environment || 'master',
    });
    this.locale = contentful.locale || 'en-US';
    this.identifier = contentful.identifier;
    this.contentTypes = contentful.contentTypes || [];

    // redis functions
    this.rGet = promisify(this.redisClient.get).bind(this.redisClient);
    this.rScan = promisify(this.redisClient.scan).bind(this.redisClient);
    this.rSet = promisify(this.redisClient.set).bind(this.redisClient);
    this.rHGet = promisify(this.redisClient.hget).bind(this.redisClient);
    this.rHSet = promisify(this.redisClient.hset).bind(this.redisClient);
    this.rDel = promisify(this.redisClient.del).bind(this.redisClient);
  }

  // Public Methods
  async sync(shouldReset) {
    try {
      const promises = [];

      let isInitial;
      let nextSyncToken;
      if (shouldReset) {
        isInitial = true;
      } else {
        nextSyncToken = await this.rHGet('redis-contentful', 'nextSyncToken');
        isInitial = !nextSyncToken;
      }

      const response = await this.cfClient.sync({
        ...(isInitial && { initial: true }),
        ...(!isInitial && { nextSyncToken }),
      });

      if (isInitial) {
        const flushdb = promisify(this.redisClient.flushdb).bind(
          this.redisClient
        );
        await flushdb();
      }

      // Adding all new entries in redis
      if (response.entries && response.entries.length) {
        const finalEntries = this.contentTypes.length
          ? response.entries.filter(
              entry =>
                this.contentTypes.indexOf(entry.sys.contentType.sys.id) > -1
            )
          : response.entries;

        finalEntries.forEach(entry => {
          const { sys } = entry;
          const contentType = sys.contentType.sys.id;
          const extracted = extract(entry, this.locale);
          promises.push(
            this.rSet(
              `${contentType}:${(entry.fields &&
                entry.fields[this.identifier] &&
                entry.fields[this.identifier][this.locale]) ||
                ''}:${sys.id}`,
              JSON.stringify(extracted)
            )
          );
        });
      }

      // Deleting all the deleted entries from redis
      if (response.deletedEntries && response.deletedEntries.length) {
        // eslint-disable-next-line no-restricted-syntax
        for (const entry of response.deletedEntries) {
          const { sys } = entry;
          // eslint-disable-next-line no-await-in-loop
          const responseKey = await this.rScan('0', 'MATCH', `*:*:${sys.id}`);

          if (responseKey[1]) {
            promises.push(this.rDel(responseKey[1]));
          }
        }
      }

      await this.rHSet(
        'redis-contentful',
        'nextSyncToken',
        response.nextSyncToken
      );

      await Promise.all(promises);
      return { message: 'Sync Complete' };
    } catch (error) {
      throw new Error(error);
    }
  }

  async get(details) {
    let response = [];
    let keys = [];

    if (typeof details === 'string') {
      response = await this.rScan(
        '0',
        'MATCH',
        `${details}:*:*`,
        'COUNT',
        '10000'
      );
      keys = response[1] || [];
    } else if (details instanceof Array) {
      const keyPromises = details.map(type =>
        this.rScan(
          '0',
          'MATCH',
          `${type || '*'}:${details.search || '*'}:*`,
          'COUNT',
          '10000'
        )
      );
      const keyResponses = await Promise.all(keyPromises);
      const keysArray = keyResponses.map(keyResponse => keyResponse[1]);
      keys = Array.prototype.concat(...keysArray);
    } else if (details instanceof Object) {
      if (typeof details.type === 'string') {
        response = await this.rScan(
          '0',
          'MATCH',
          `${details.type || '*'}:${details.search || '*'}:*`,
          'COUNT',
          '10000'
        );
        keys = response[1] || [];
      } else if (details.type instanceof Array) {
        const keyPromises = details.type.map(type =>
          this.rScan(
            '0',
            'MATCH',
            `${type || '*'}:${details.search || '*'}:*`,
            'COUNT',
            '10000'
          )
        );
        const keyResponses = await Promise.all(keyPromises);
        const keysArray = keyResponses.map(keyResponse => keyResponse[1]);
        keys = Array.prototype.concat(...keysArray);
      }
    }

    const promises = keys.map(key => this.rGet(key));
    const responses = await Promise.all(promises);

    const final = {};
    for (let index = 0; index < keys.length; index += 1) {
      const type = keys[index].split(':').shift();

      if (final[type]) {
        final[type].push(JSON.parse(responses[index]));
      } else {
        final[type] = [JSON.parse(responses[index])];
      }
    }
    return final;
  }

  /**
   *
   * @param {string} key - provide string as key
   * @param {string} value - provide string as value
   * @param {number} expire - provide number in seconds
   */
  setCustom(key, value, expire) {
    if (typeof key === 'string') {
      const set = promisify(this.redisClient.set).bind(this.redisClient);
      if (expire) {
        return set(key, JSON.stringify(value), 'EX', expire);
      }
      return set(key, JSON.stringify(value));
    }
    throw new Error('setCustom - key should be a string');
  }

  async getCustom(key) {
    if (typeof key === 'string') {
      const get = promisify(this.redisClient.get).bind(this.redisClient);
      const response = await get(key);

      return JSON.parse(response);
    }
    throw new Error('getCustom - key should be a string');
  }

  deleteCustom(key) {
    if (typeof key === 'string') {
      const del = promisify(this.redisClient.del).bind(this.redisClient);
      return del(key);
    }
    throw new Error('deleteCustom - key should be a string');
  }

  setDB(index = 0) {
    const select = promisify(this.redisClient.select).bind(this.redisClient);
    return select(index);
  }

  async close() {
    this.redisClient.quit();
  }
}

module.exports = RedisContentful;
