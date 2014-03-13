
var raptorPromises = require('raptor-promises');
var releaseBranchRegExp = /^v([0-9]+\.[0-9]+)$/i;
var releaseBranchAltRegExp = /^release-([0-9]+\.[0-9]+)\.x$/i;

var File = require('raptor-files/File');
var findPreReleaseVersions = require('./findPreReleaseVersions');

module.exports = {
    usage: 'Usage: $0 $commandName',

    options: {
        'clean': {
            describe: 'Clean the workspace before publish (defaults to false)',
            type: "boolean",
            default: false
        },
        'public': {
            describe: 'Publish to the public npm registry (defaults to false)',
            type: "boolean",
            default: false
        },
        'skip-tests': {
            describe: 'Skip running tests before publish (not recommended)',
            type: "boolean",
            default: false
        },
        'skip-git-checks': {
            describe: 'Skip checks that ensure the Git workspace is clean and in-sync with the remote branch (not recommended)',
            type: "boolean",
            default: false  
        }
    },

    validate: function(args, rapido) {
        return {
            clean: args.clean === true,
            skipTests: args['skip-tests'] === true,
            skipGitChecks: args['skip-git-checks'] === true
        };
    },

    run: function(args, config, rapido) {

        var projectManager = rapido.projectManager;
        var logger = args.logger || rapido.util.replayLogger();
        var nodeModulesDir;
        var packageManifest;
        var rootDir = args.cwd || projectManager.rootDir;
        var userConfig;
        var npmRegistryWrite;
        var npmRegistryRead;
        var publishVersion;
        var gitBranch;
        var moduleVersion;

        function spawnNpm(args, options) {
            options = options || {};
            options.logger = logger;
            options.cwd = rootDir;
            return rapido.util.spawnNpm(args, options);
        }

        function spawnGit(args, options) {
            options = options || {};
            options.logger = logger;
            options.cwd = rootDir;
            return rapido.util.spawnGit(args, options);
        }

        function resolveGitTag(version) {
            return 'v' + version;
        }

        function init() {

            return projectManager.read(['package', 'git', 'npm'], {cwd: rootDir})
                .then(function(projectInfo) {
                    packageManifest = projectInfo.package;
                    nodeModulesDir = new File(projectInfo.rootDir, "node_modules");
                    publishVersion = packageManifest.version;
                    gitBranch = projectInfo.git.branch;
                    moduleVersion = packageManifest.parsedVersion;
                    npmRegistryWrite = projectInfo.npm.registryWrite;
                    npmRegistryRead = projectInfo.npm.registryRead;
                    userConfig = projectInfo.npm.userConfig;
                });   
        }

        function validate() {
            if (!moduleVersion.valid) {
                throw "Unable to parse version in package.json: " + packageManifest.version;
            }

            if (!gitBranch) {
                throw 'Unable to determine git branch. Aborting';
            }

            rapido.log.info('Git branch: ' + gitBranch);

            var releaseBranchVersionParts = releaseBranchRegExp.exec(gitBranch) || releaseBranchAltRegExp.exec(gitBranch);
            
            if (releaseBranchVersionParts) {
                // We are on a release branch...
                var releaseBranchVersion = rapido.util.version.parse(releaseBranchVersionParts[1]);
                // Make sure the major and minor versions match
                
                if (releaseBranchVersion.major !== moduleVersion.major ||
                    releaseBranchVersion.minor !== moduleVersion.minor) {
                    throw "Release branch version does not match version in package.json. Branch: " + gitBranch + ', Module version: ' + moduleVersion;
                }
            }
            else {
                // We are on a non-release branch... SNAPSHOT label is required
                if (!moduleVersion.label) {
                    throw 'pre-release label (e.g. "-beta") is required in version on non-release branches. Actual version: ' + packageManifest.version;
                }
            }

            var npmRcFile = new File(userConfig);
            if (!npmRcFile.exists()) {
                throw 'npm user config does not exist at path "' + userConfig + '".\nThis file should contain the configuration for an authenticated npm user session.';
            }
        }

        function clean() {
            if (args.clean) {
                return spawnGit(['reset', '--hard', 'HEAD'])
                    .then(function() {
                        return spawnGit(['clean', '-df']);
                    })
                    .then(function() {
                        if (nodeModulesDir.exists()) {
                            logger.info('delete', 'Removing "' + nodeModulesDir.getAbsolutePath() + '"...');
                            nodeModulesDir.remove();
                            logger.info('delete', 'Removed "' + nodeModulesDir.getAbsolutePath() + '"');
                        }
                    });
            }
        }

        function checkClean() {
            if (args.skipGitChecks) {
                return;
            }

            return spawnGit(['status', '--porcelain'])
                .then(function(result) {
                    var stdout = result.stdout;
                    if (stdout.trim() !== '') {
                        throw 'A module cannot be published unless the Git workspace is clean. Actual Git status:\n' + stdout;
                    }
                });
        }

        function checkPushPull() {
            if (args.skipGitChecks) {
                return;
            }

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
                    return spawnGit(['log', 'HEAD..origin/' + gitBranch, '--oneline']);
                })
                .then(function(result) {
                    var stdout = result.stdout;
                    if (stdout.trim() !== '') {
                        throw 'A module cannot be published unless all commits have been pulled from the upstream repository.\nThe following commits have not been pulled:\n' + stdout;
                    }

                });
        }

        function checkChanges() {

            var tag = resolveGitTag(moduleVersion.version);

            var headSha1 = spawnGit(['rev-parse', 'HEAD'])
                .then(function(result) {
                    return result.stdout.trim();
                });

            var tagSha1 = spawnGit(['rev-parse', '--verify', tag + '^{commit}'], {expectError: true})
                .then(function(result) {
                    return result.stdout.trim();
                })
                .fail(function(result) {
                    return null; // Tag does not exist
                });

            return raptorPromises.all([headSha1, tagSha1])
                .then(function(results) {
                    var headSha1 = results[0];
                    var tagSha1 = results[1];

                    if (headSha1 === tagSha1) {
                        logger.info('No changes have been made since the last publish! The Git HEAD is currently at ' + tag);
                        return {
                            hasChanges: false
                        };
                    }
                    else {
                        return {
                            hasChanges: true
                        };
                    }
                });
        }

        function npmInstall() {
            logger.info('Installing all node modules...');
            return spawnNpm(['install', '--registry', npmRegistryRead]);
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
            if (!args.skipTests) {
                return rapido.runCommand('module', 'test', {
                        logger: logger,
                        clean: false,
                        cwd: rootDir
                    });
            }
            
        }

        function updatePatchVersion() {
            var currentVersion = packageManifest.version;

            function checkPublished() {
                logger.info('Checking if this version has already been published...');

                return rapido.util.request({
                        url: npmRegistryRead + '/' + packageManifest.name + '/' + currentVersion,
                        logResponses: false,
                        logger: logger
                    })
                    .then(function(data) {
                        return {
                            published: true
                        };
                    })
                    .fail(function() {
                        return {
                            published: false
                        };
                    });
            }

            return checkPublished()
                .then(function(publishedCheckResult) {
                    if (publishedCheckResult.published) {
                        logger.info('Current version has already been published to npm. Patch version will be incremented');
                        packageManifest.parsedVersion.incPatch();
                        publishVersion = packageManifest.version;
                        return packageManifest.write()
                            .then(function() {
                                return spawnGit(['commit', 'package.json', '-m', 'Updated version to ' + packageManifest.version]);
                            })
                            .then(function() {
                                logger.info('Pushing changes to package.json...');
                                return spawnGit(['push', 'origin', gitBranch]);
                            });
                    } else {
                        logger.info('Current version has not been published to npm. Will publish version ' + packageManifest.version);
                    }
                });
        }
        function beforePublish() {
            var scripts = config.scripts;
            if (scripts && scripts['before-publish']) {
                return rapido.util.exec(scripts['before-publish'], {
                    cwd: config['before-publish.cwd.dir'] || rootDir
                });
            }
        }

        function npmPublish() {

            logger.info('Publishing module...');

            var npmPublishArgs = ['publish', '--tag', 'latest', '--registry', npmRegistryWrite];

            logger.info('Using npm configuration directory at path "' + userConfig + '"');

            npmPublishArgs = npmPublishArgs.concat(["--userconfig", userConfig]);

            logger.info('Publishing module to npm registry (' + npmRegistryWrite + ')...');
            return spawnNpm(npmPublishArgs);
        }

        function addGitTag() {
            var tag = resolveGitTag(packageManifest.parsedVersion);

            return spawnGit(['pull', 'origin', gitBranch])
                .then(function() {
                    return spawnGit(['tag', tag]);
                })
                .then(function() {
                    return spawnGit(['push', '--tags', 'origin', gitBranch]);
                });
        }

        function addNpmTag() {
            // if (packageManifest.parsedVersion.label) {
            //     logger.info('Adding npm tag to published module...');

            //     var snapshotVersion = packageManifest.parsedVersion.clone();
            //     snapshotVersion.patch = 'x';
            //     snapshotVersion.build = null;
            //     var tag = 'v' + snapshotVersion;
            //     tag = tag.replace(/[\.]/g, '_'); // npm won't allow dots...

            //     var npmTagArgs = ['tag', packageManifest.name + '@' + publishVersion, tag, '--registry', npmRegistryWrite, "--userconfig", userConfig];
            //     return spawnNpm(npmTagArgs);
            // }
        }

        return init()
            .then(validate)
            .then(ensureNoPreReleaseVersions.bind(this, false /* not recursive */))
            .then(clean)
            .then(checkClean)
            .then(checkPushPull)
            .then(checkChanges)
            .then(function(checkChangesResult) {
                if (checkChangesResult.hasChanges) {
                    return raptorPromises.makePromise()
                        .then(npmInstall)
                        .then(ensureNoPreReleaseVersions.bind(this, true /* recursive */))
                        .then(runTests)
                        .then(updatePatchVersion)
                        .then(beforePublish)
                        .then(npmPublish)
                        .then(addGitTag)
                        .then(addNpmTag)
                        .then(function() {
                            if (!args.logger) {
                                // Only log if we created the logger (it was not provided as input)
                                rapido.log();
                                logger.summarize();
                            }
                            
                            logger.success('success', 'Module ' + packageManifest.name + '@' + publishVersion + ' successfully published!');
                        });
                }
            });
    }
};
