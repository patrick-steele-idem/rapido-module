var File = require('raptor-files/File');
var raptorPromises = require('raptor-promises');

module.exports = {
    usage: 'Usage: $0 $commandName',

    options: {
        'clean': {
            describe: 'Clean the node_modules directory',
            type: 'boolean',
            default: false
        }
    },

    validate: function(args, rapido) {
        return args;
    },

    run: function(args, config, rapido) {
        var logger = args.logger || rapido.util.replayLogger();

        function spawnNpm(args, options) {
            options = options || {};
            options.logger = logger;
            return rapido.util.spawnNpm(args, options, logger);
        }

        var npmRegistry;
        var packageManifest;
        var nodeModulesDir;

        function init() {
            return rapido.projectManager.read(['package', 'npm'])
                .then(function(projectInfo) {
                    packageManifest = projectInfo.package;
                    nodeModulesDir = new File(projectInfo.rootDir, "node_modules");
                    npmRegistry = projectInfo.npm.registryRead;
                });
        }

        function reinstallNodeModules() {
            if (args.clean) {
                logger.info('Cleaning node_modules...');
                return spawnNpm(['cache', 'clean'])
                    .then(function() {
                        if (nodeModulesDir.exists()) {
                            logger.info('delete', 'Removing "' + nodeModulesDir.getAbsolutePath() + '"...');
                            nodeModulesDir.remove();    
                            logger.info('delete', 'Removed "' + nodeModulesDir.getAbsolutePath() + '"');
                        }
                    })
                    .then(function() {
                        logger.info('Installing Node module dependencies...');
                        return spawnNpm(['install', '--registry', npmRegistry]);
                    });
            }
        }

        function runTests() {
            logger.info('Running top-level tests for "' + packageManifest.name + '"...');
                    return spawnNpm(['test']);
        }

        return raptorPromises.makePromise()
            .then(init)
            .then(reinstallNodeModules)
            .then(runTests)
            .then(function() {
                if (!args.logger) {
                    rapido.log();
                    logger.summarize();    
                }
                
                logger.success('success', 'All tests successfully passed!');
            });
    }
};
