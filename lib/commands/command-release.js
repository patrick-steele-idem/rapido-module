var raptorPromises = require('raptor-promises');
var File = require('raptor-files/File');
var findPreReleaseVersions = require('./findPreReleaseVersions');

module.exports = {
    usage: 'Usage: $0 $commandName',

    options: {
        'skip-tests': {
            describe: 'Skip running tests before publish (not recommended)',
            type: "boolean",
            default: false
        }
    },

    validate: function(args, rapido) {
        return {
            skipTests: args['skip-tests'] === true
        };
    },

    run: function(args, config, rapido) {
        var logger = args.logger || rapido.util.replayLogger();
        var nodeModulesDir;
        var packageManifest;
        var releaseBranchName;
        var gitBranch;
        var npmRegistryRead;
        var npmRegistryWrite;

        function spawnNpm(args, options) {
            options = options || {};
            options.logger = logger;
            return rapido.util.spawnNpm(args, logger);
        }

        function spawnGit(args, options) {
            options = options || {};
            options.logger = logger;
            return rapido.util.spawnGit(args, logger);
        }

        function init() {
            return rapido.projectManager.read(['package', 'git', 'npm'], {force: true})
                .then(function(projectInfo) {
                    packageManifest = projectInfo.package;
                    nodeModulesDir = new File(projectInfo.rootDir, "node_modules");
                    releaseBranchName = 'v' + packageManifest.parsedVersion.major + '.' + packageManifest.parsedVersion.minor;
                    gitBranch = projectInfo.git.branch;
                    npmRegistryWrite = projectInfo.npm.registryWrite;
                    npmRegistryRead = projectInfo.npm.registryRead;
                    // console.log('PROJECT INFO ', projectInfo, 
                    //     'releaseBranchName: ', releaseBranchName, 
                    //     'packageManifest.parsedVersion: ', packageManifest.parsedVersion, 
                    //     'packageManifest.parsedVersion.toString(): ', packageManifest.parsedVersion.toString(),
                    //     'packageManifest.version: ', packageManifest.version);
                });
        }

        function validate() {
            if (gitBranch !== 'master') {
                throw 'A module can only be released from master';
            }

            if (!packageManifest.parsedVersion.label) {
                throw 'Version should include pre-release label on master (e.g. "-beta")';
            }
        }

        function checkClean() {
            return spawnGit(['status', '--porcelain'])
                .then(function(result) {
                    var stdout = result.stdout;
                    if (stdout.trim() !== '') {
                        throw 'A module cannot be published unless the Git workspace is clean. Actual Git status:\n' + stdout;
                    }
                });
        }

        function clean() {
            if (nodeModulesDir.exists()) {
                logger.info('delete', 'Removing "' + nodeModulesDir.getAbsolutePath() + '"...');
                nodeModulesDir.remove();
                logger.info('delete', 'Removed "' + nodeModulesDir.getAbsolutePath() + '"');
            }
        }

        function checkPushPull() {
            return spawnGit(['cherry', '-v'])
                .then(function(result) {
                    var stdout = result.stdout;
                    if (stdout.trim() !== '') {
                        throw 'A module cannot be published unless all commits have been pushed to the upstream repository.\nThe following commits have not been pushed:\n' + stdout;
                    }

                })
                .then(function() {
                    //git fetch origin
                    return spawnGit(['fetch', 'origin']);
                })
                .then(function() {
                    return spawnGit(['log', 'HEAD..origin/master', '--oneline']);
                })
                .then(function(result) {
                    var stdout = result.stdout;
                    if (stdout.trim() !== '') {
                        throw 'A module cannot be published unless all commits have been pulled from the upstream repository.\nThe following commits have not been pulled:\n' + stdout;
                    }

                });
        }

        function ensureNoPreReleaseVersions(recursive) {
            if (packageManifest.parsedVersion.label) {
                // SNAPSHOT/pre-release versions are allowed for modules with a pre-release label
                return;
            }

            var snapshotModules = findPreReleaseVersions(packageManifest, recursive !== false);

            if (snapshotModules.length) {
                throw 'Unable to publish module since it depends on pre-release versions:\n- ' + snapshotModules.join('\n -') + '\n\npackage.json should be modified as to not depend on any pre-release versions.';
            }
        }

        function runTests() {
            logger.info('Running module tests...');
            return spawnNpm(['test']);
        }

        

        function updateReleaseBranch() {
            function createReleaseBranch() {
                logger.info('Creating release branch (' + releaseBranchName + ') from master...');
                return spawnGit(['checkout', '-b', releaseBranchName]);
            }
            

            function removeSnapshotLabel() {
                logger.info('Removing pre-release label on "' + releaseBranchName + '"...');
                packageManifest.parsedVersion.label = null;
                packageManifest.parsedVersion.build = null;
                return packageManifest.write();
            }

            function commit() {
                logger.info('Committing changes to package.json...');
                var commitMessage = 'Updated version to ' + packageManifest.version;
                return spawnGit(['commit', '-a', '-m', commitMessage]);
            }

            function push() {
                logger.info('Pushing changes to package.json...');
                return spawnGit(['push', '-u', 'origin', releaseBranchName]);
            }

            function publish() {
                logger.info('Publishing new release version...');
                return rapido.runCommand('module', 'publish', {
                        logger: logger,
                        skipTests: args.skipTests
                    });
            }

            return createReleaseBranch()
                .then(init) // Reload the Git info after we switch branches
                .then(removeSnapshotLabel)
                .then(commit)
                .then(push)
                .then(publish);
        }

        

        function updateMaster() {
            function checkoutMaster() {
                logger.info('Checking out the "master" branch...');
                return spawnGit(['checkout', 'master']);
            }

            function incMinor() {
                logger.info('Incrementing minor version on "master"...');
                packageManifest.parsedVersion.incMinor();
                packageManifest.parsedVersion.label = 'beta';
                return packageManifest.write();
            }

            function commit() {
                logger.info('Committing changes to package.json...');
                var commitMessage = 'Updated version to ' + packageManifest.version;
                return spawnGit(['commit', '-a', '-m', commitMessage]);
            }

            function push() {
                logger.info('Pushing changes to package.json...');
                return spawnGit(['push', 'origin', gitBranch]);
            }

            // function publish() {
            //     logger.info('Publishing new pre-release version...');
            //     return rapido.runCommand('module', 'publish', {
            //             logger: logger,
            //             skipTests: args.skipTests
            //         });
            // }

            return checkoutMaster()
                .then(init) // Reload the Git info after we switch branches
                .then(incMinor)
                .then(commit)
                .then(push);
        }

        return raptorPromises.makePromise()
            .then(init)
            .then(validate)
            .then(ensureNoPreReleaseVersions.bind(this, false /* not recursive */))
            .then(checkClean)
            .then(clean)
            .then(checkPushPull)
            .then(ensureNoPreReleaseVersions.bind(this, true /* recursive */))
            .then(runTests)
            .then(updateReleaseBranch)
            .then(updateMaster)
            .then(function() {
                if (!args.logger) {
                    // Only log if we created the logger (it was not provided as input)
                    rapido.log();
                    logger.summarize();
                }
                
                logger.success('success', 'Release completed');
            });
    }
};
