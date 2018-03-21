var _ = require('underscore');
var assert = require('assert');
var crypto = require('crypto');
var dot = require('dot');
var step = require('step');
var MapConfig = require('windshaft').model.MapConfig;
var templateName = require('../../../backends/template_maps').templateName;
var QueryTables = require('cartodb-query-tables');

/**
 * @constructor
 * @type {NamedMapMapConfigProvider}
 */
function NamedMapMapConfigProvider(
    templateMaps,
    pgConnection,
    metadataBackend,
    userLimitsApi,
    mapConfigAdapter,
    affectedTablesCache,
    owner,
    templateId,
    config,
    authToken,
    params
) {
    this.templateMaps = templateMaps;
    this.pgConnection = pgConnection;
    this.metadataBackend = metadataBackend;
    this.userLimitsApi = userLimitsApi;
    this.mapConfigAdapter = mapConfigAdapter;

    this.owner = owner;
    this.templateName = templateName(templateId);
    this.config = config;
    this.authToken = authToken;
    this.params = params;

    this.cacheBuster = Date.now();

    // use template after call to mapConfig
    this.template = null;

    this.affectedTablesCache = affectedTablesCache;

    // providing
    this.err = null;
    this.mapConfig = null;
    this.rendererParams = null;
    this.context = {};
    this.analysesResults = [];
}

module.exports = NamedMapMapConfigProvider;

NamedMapMapConfigProvider.prototype.getMapConfig = function(callback) {
    if (!!this.err || this.mapConfig !== null) {
        return callback(this.err, this.mapConfig, this.rendererParams, this.context);
    }

    var self = this;

    var mapConfig = null;
    var rendererParams;
    var apiKey;

    var context = {};

    step(
        function getTemplate() {
            self.getTemplate(this);
        },
        function prepareDbParams(err, tpl) {
            assert.ifError(err);
            self.template = tpl;

            rendererParams = _.extend({}, self.params, {
                user: self.owner
            });
            self.setDBParams(self.owner, rendererParams, this);
        },
        function getUserApiKey(err) {
            assert.ifError(err);
            self.metadataBackend.getUserMapKey(self.owner, this);
        },
        function prepareParams(err, _apiKey) {
            assert.ifError(err);

            apiKey = _apiKey;

            var templateParams = {};
            if (self.config) {
                try {
                    templateParams = _.isString(self.config) ? JSON.parse(self.config) : self.config;
                } catch (e) {
                    throw new Error('malformed config parameter, should be a valid JSON');
                }
            }

            return templateParams;
        },
        function instantiateTemplate(err, templateParams) {
            assert.ifError(err);
            context.templateParams = templateParams;
            return self.templateMaps.instance(self.template, templateParams);
        },
        function prepareAdapterMapConfig(err, requestMapConfig) {
            assert.ifError(err);
            context.analysisConfiguration = {
                user: self.owner,
                db: {
                    host: rendererParams.dbhost,
                    port: rendererParams.dbport,
                    dbname: rendererParams.dbname,
                    user: rendererParams.dbuser,
                    pass: rendererParams.dbpassword
                },
                batch: {
                    username: self.owner,
                    apiKey: apiKey
                }
            };
            self.mapConfigAdapter.getMapConfig(self.owner, requestMapConfig, rendererParams, context, this);
        },
        function prepareContextLimits(err, _mapConfig) {
            assert.ifError(err);
            mapConfig = _mapConfig;
            self.userLimitsApi.getRenderLimits(self.owner, self.params.api_key, this);
        },
        function cacheAndReturnMapConfig(err, renderLimits) {
            self.err = err;
            self.mapConfig = (mapConfig === null) ? null : new MapConfig(mapConfig, context.datasource);
            self.analysesResults = context.analysesResults || [];
            self.rendererParams = rendererParams;
            self.context = context;
            self.context.limits = renderLimits || {};
            return callback(self.err, self.mapConfig, self.rendererParams, self.context);
        }
    );
};

NamedMapMapConfigProvider.prototype.getTemplate = function(callback) {
    var self = this;

    if (!!this.err || this.template !== null) {
        return callback(this.err, this.template);
    }

    step(
        function getTemplate() {
            self.templateMaps.getTemplate(self.owner, self.templateName, this);
        },
        function checkExists(err, tpl) {
            assert.ifError(err);
            if (!tpl) {
                var notFoundErr = new Error(
                        "Template '" + self.templateName + "' of user '" + self.owner + "' not found"
                );
                notFoundErr.http_status = 404;
                throw notFoundErr;
            }
            return tpl;
        },
        function checkAuthorized(err, tpl) {
            assert.ifError(err);

            var authorized = false;
            try {
                authorized = self.templateMaps.isAuthorized(tpl, self.authToken);
            } catch (err) {
                // we catch to add http_status
                var authorizationFailedErr = new Error('Failed to authorize template');
                authorizationFailedErr.http_status = 403;
                throw authorizationFailedErr;
            }
            if ( ! authorized ) {
                var unauthorizedErr = new Error('Unauthorized template instantiation');
                unauthorizedErr.http_status = 403;
                throw unauthorizedErr;
            }

            return tpl;
        },
        function cacheAndReturnTemplate(err, template) {
            self.err = err;
            self.template = template;
            return callback(self.err, self.template);
        }
    );
};

NamedMapMapConfigProvider.prototype.getKey = function() {
    return this.createKey(false);
};

NamedMapMapConfigProvider.prototype.getCacheBuster = function() {
    return this.cacheBuster;
};

NamedMapMapConfigProvider.prototype.reset = function() {
    this.template = null;

    this.affectedTables = null;

    this.err = null;
    this.mapConfig = null;

    this.cacheBuster = Date.now();
};

NamedMapMapConfigProvider.prototype.filter = function(key) {
    var regex = new RegExp('^' + this.createKey(true) + '.*');
    return key && key.match(regex);
};

// Configure bases for cache keys suitable for string interpolation
var baseKey = '{{=it.dbname}}:{{=it.owner}}:{{=it.templateName}}';
var rendererKey = baseKey + ':{{=it.authToken}}:{{=it.configHash}}:{{=it.format}}:{{=it.layer}}:{{=it.scale_factor}}';

var baseKeyTpl = dot.template(baseKey);
var rendererKeyTpl = dot.template(rendererKey);

NamedMapMapConfigProvider.prototype.createKey = function(base) {
    var tplValues = _.defaults({}, this.params, {
        dbname: '',
        owner: this.owner,
        templateName: this.templateName,
        authToken: this.authToken || '',
        configHash: configHash(this.config),
        layer: '',
        scale_factor: 1
    });
    return (base) ? baseKeyTpl(tplValues) : rendererKeyTpl(tplValues);
};

function configHash(config) {
    if (!config) {
        return '';
    }
    return crypto.createHash('md5').update(JSON.stringify(config)).digest('hex').substring(0,8);
}

module.exports.configHash = configHash;

NamedMapMapConfigProvider.prototype.setDBParams = function(cdbuser, params, callback) {
    this.pgConnection.getDatabaseParams(cdbuser, (err, databaseParams) => {
        if (err) {
            return callback(err);
        }

        params.dbuser = databaseParams.dbuser;
        params.dbpass = databaseParams.dbpass;
        params.dbhost = databaseParams.dbhost;
        params.dbport = databaseParams.dbport;
        params.dbname = databaseParams.dbname;

        callback();
    });
};

NamedMapMapConfigProvider.prototype.getTemplateName = function() {
    return this.templateName;
};

NamedMapMapConfigProvider.prototype.getAffectedTables = function(callback) {
    var self = this;

    let dbname = null;
    let token = null;

    step(
        function getMapConfig() {
            self.getMapConfig(this);
        },
        function getSql(err, mapConfig) {
            assert.ifError(err);

            dbname = self.rendererParams;
            token = mapConfig.id();

            if (self.affectedTablesCache.hasAffectedTables(dbname, token)) {
                const affectedTables = self.affectedTablesCache.get(dbname, token);
                return callback(null, affectedTables);
            }

            const queries = [];

            mapConfig.getLayers().forEach(layer => {
                queries.push(layer.options.sql);
                if (layer.options.affected_tables) {
                    layer.options.affected_tables.map(table => {
                        queries.push(`SELECT * FROM ${table} LIMIT 0`);
                    });
                }
            });

            const sql = queries.length ? queries.join(';') : null;

            if (!sql) {
                return callback();
            }

            return sql;
        },
        function getAffectedTables(err, sql) {
            assert.ifError(err);
            step(
                function getConnection() {
                    self.pgConnection.getConnection(self.owner, this);
                },
                function getAffectedTables(err, connection) {
                    assert.ifError(err);
                    QueryTables.getAffectedTablesFromQuery(connection, sql, this);
                },
                this
            );
        },
        function finish(err, affectedTables) {
            if (err) {
                return callback(err);
            }

            self.affectedTablesCache.set(dbname, token, affectedTables);

            return callback(err, affectedTables);
        }
    );
};
