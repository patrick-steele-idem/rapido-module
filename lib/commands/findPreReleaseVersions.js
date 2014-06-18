var nodePath = require('path');
var File = require('raptor-files').File;

function relativePath(filePath) {
    if (filePath instanceof File) {
        filePath = filePath.getAbsolutePath();
    }
    return nodePath.relative(process.cwd(), filePath);
}

module.exports = function findPreReleaseVersions(pkg, recursive) {
    // if (project.version.label === 'pre-release') {
    //     // pre-release versions are allowed for pre-release modules
    //     return;
    // }

    var snapshotModules = [];

    function checkDependencies(pkg, type, packageFile) {
        var dependencies = pkg[type];
        if (!dependencies) {
            return;
        }

        for (var moduleName in dependencies) {
            if (dependencies.hasOwnProperty(moduleName)) {
                var moduleVersion = dependencies[moduleName].toLowerCase();
                if (moduleVersion.indexOf('-beta') !== -1 || moduleVersion.indexOf('-snapshot') !== -1) { // Look for a "-" as a pre-release indicator for a module
                    snapshotModules.push(moduleName + '@' + moduleVersion + ' in ' + relativePath(packageFile) + ' (' + type + ')');
                }
            }
        }
    }

    var pkgFilename = pkg.path;

    // console.log('PACKAGE PATH: ', pkg.path);

    function checkPackage(pkg, packageFile) {
        checkDependencies(pkg, 'dependencies', packageFile);
        checkDependencies(pkg, 'devDependencies', packageFile);
    }

    // Check the root package
    checkPackage(pkg, pkgFilename);

    function checkPackagesRecursive(dir) {
        var nodeModulesDir = new File(dir, "node_modules");
        if (!nodeModulesDir.exists()) {
            return;
        }

        nodeModulesDir.listFiles().forEach(function(moduleDir) {
            if (moduleDir.isDirectory()) {
                var packageFile = new File(moduleDir, 'package.json');
                if (packageFile.exists()) {
                    checkPackage(JSON.parse(packageFile.readAsString()), packageFile);
                    checkPackagesRecursive(moduleDir);
                }
            }
        });
    }

    if (recursive !== false) {
        checkPackagesRecursive(nodePath.dirname(pkgFilename));
    }
    
    if (snapshotModules.length) {
        throw 'Unable to publish module since it depends on pre-release versions:\n- ' + snapshotModules.join('\n -') + '\n\npackage.json should be modified as to not depend on any pre-release versions.';
    }

    return snapshotModules;
};