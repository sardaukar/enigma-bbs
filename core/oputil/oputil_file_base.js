/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const printUsageAndSetExitCode	= require('./oputil_common.js').printUsageAndSetExitCode;
const ExitCodes					= require('./oputil_common.js').ExitCodes;
const argv						= require('./oputil_common.js').argv;
const initConfigAndDatabases	= require('./oputil_common.js').initConfigAndDatabases;
const getHelpFor				= require('./oputil_help.js').getHelpFor;
const getAreaAndStorage			= require('./oputil_common.js').getAreaAndStorage;
const Errors					= require('../../core/enig_error.js').Errors;

const async						= require('async');
const fs						= require('fs');
const paths						= require('path');
const _							= require('lodash');
const moment					= require('moment');

exports.handleFileBaseCommand			= handleFileBaseCommand;

/*
	:TODO:

	Global options:
		--yes: assume yes
		--no-prompt: try to avoid user input 

	Prompt for import and description before scan
		* Only after finding duplicate-by-path
		* Default to filename -> desc if auto import

*/

let fileArea;	//	required during init

function scanFileAreaForChanges(areaInfo, options, cb) {

	const storageLocations = fileArea.getAreaStorageLocations(areaInfo).filter(sl => {
		return options.areaAndStorageInfo.find(asi => {
			return !asi.storageTag || sl.storageTag === asi.storageTag;
		});
	});
	
	async.eachSeries(storageLocations, (storageLoc, nextLocation) => {
		async.series(
			[
				function scanPhysFiles(callback) {
					const physDir = storageLoc.dir;

					fs.readdir(physDir, (err, files) => {
						if(err) {
							return callback(err);
						}

						async.eachSeries(files, (fileName, nextFile) => {
							const fullPath = paths.join(physDir, fileName);

							fs.stat(fullPath, (err, stats) => {
								if(err) {
									//	:TODO: Log me!
									return nextFile(null);	//	always try next file
								}

								if(!stats.isFile()) {
									return nextFile(null);
								}

								process.stdout.write(`Scanning ${fullPath}... `);

								fileArea.scanFile(
									fullPath,
									{
										areaTag		: areaInfo.areaTag,
										storageTag	: storageLoc.storageTag
									},
									(err, fileEntry, dupeEntries) => {
										if(err) {
											//	:TODO: Log me!!!
											console.info(`Error: ${err.message}`);											
											return nextFile(null);	//	try next anyway
										}

										

										if(dupeEntries.length > 0) {
											//	:TODO: Handle duplidates -- what to do here???
											console.info('Dupe');
											return nextFile(null);
										} else {
											console.info('Done!');
											if(Array.isArray(options.tags)) {
												options.tags.forEach(tag => {
													fileEntry.hashTags.add(tag);
												});
											}

											fileEntry.persist( err => {
												return nextFile(err);
											});
										}
									}
								);
							});
						}, err => {
							return callback(err);
						});
					});
				},
				function scanDbEntries(callback) {
					//	:TODO: Look @ db entries for area that were *not* processed above
					return callback(null);
				}
			], 
			err => {
				return nextLocation(err);
			}
		);
	}, 
	err => {
		return cb(err);
	});
}

function dumpAreaInfo(areaInfo, areaAndStorageInfo, cb) {
	console.info(`areaTag: ${areaInfo.areaTag}`);
	console.info(`name: ${areaInfo.name}`);
	console.info(`desc: ${areaInfo.desc}`);

	areaInfo.storage.forEach(si => {
		console.info(`storageTag: ${si.storageTag} => ${si.dir}`);
	});
	console.info('');
	
	return cb(null);
}

function getSpecificFileEntry(pattern, cb) {
	//	spec: FILE_ID|SHA|PARTIAL_SHA
	const FileEntry = require('../../core/file_entry.js');

	async.waterfall(
		[
			function getByFileId(callback) {
				const fileId = parseInt(pattern);
				if(!/^[0-9]+$/.test(pattern) || isNaN(fileId)) {
					return callback(null, null);
				}

				const fileEntry = new FileEntry();
				fileEntry.load(fileId, () => {
					return callback(null, fileEntry);	//	try sha
				});
			},
			function getBySha(fileEntry, callback) {
				if(fileEntry) {
					return callback(null, fileEntry);	//	already got it by sha
				}

				FileEntry.findFileBySha(pattern, (err, fileEntry) => {
					return callback(err, fileEntry);
				});
			},
		],
		(err, fileEntry) => {
			return cb(err, fileEntry);
		}
	);
}

function dumpFileInfo(shaOrFileId, cb) {
	async.waterfall(
		[
			function getEntry(callback) {
				getSpecificFileEntry(shaOrFileId, (err, fileEntry) => {
					return callback(err, fileEntry);
				});
			},
			function dumpInfo(fileEntry, callback) {
				const fullPath = paths.join(fileArea.getAreaStorageDirectoryByTag(fileEntry.storageTag), fileEntry.fileName);

				console.info(`file_id: ${fileEntry.fileId}`);
				console.info(`sha_256: ${fileEntry.fileSha256}`);
				console.info(`area_tag: ${fileEntry.areaTag}`);
				console.info(`storage_tag: ${fileEntry.storageTag}`);
				console.info(`path: ${fullPath}`);
				console.info(`hashTags: ${Array.from(fileEntry.hashTags).join(', ')}`);
				console.info(`uploaded: ${moment(fileEntry.uploadTimestamp).format()}`);
				
				_.each(fileEntry.meta, (metaValue, metaName) => {
					console.info(`${metaName}: ${metaValue}`);
				});

				if(argv['show-desc']) {
					console.info(`${fileEntry.desc}`);
				}
				console.info('');

				return callback(null);
			}
		],
		err => {
			return cb(err);
		}
	);
}

function displayFileAreaInfo() {
	//	AREA_TAG[@STORAGE_TAG]
	//	SHA256|PARTIAL
	//	if sha: dump file info
	//	if area/stoarge dump area(s) +

	async.series(
		[
			function init(callback) {
				return initConfigAndDatabases(callback);
			},	
			function dumpInfo(callback) {
				const Config = require('../../core/config.js').config;
				let suppliedAreas = argv._.slice(2);
				if(!suppliedAreas || 0 === suppliedAreas.length) {
					suppliedAreas = _.map(Config.fileBase.areas, (areaInfo, areaTag) => areaTag);
				}

				const areaAndStorageInfo = getAreaAndStorage(suppliedAreas);

				fileArea = require('../../core/file_base_area.js');

				async.eachSeries(areaAndStorageInfo, (areaAndStorage, nextArea) => {
					const areaInfo = fileArea.getFileAreaByTag(areaAndStorage.areaTag);
					if(areaInfo) {
						return dumpAreaInfo(areaInfo, areaAndStorageInfo, nextArea);
					} else {
						return dumpFileInfo(areaAndStorage.areaTag, nextArea);
					}
				},
				err => {
					return callback(err);
				});
			}
		],
		err => {
			if(err) {
				process.exitCode = ExitCodes.ERROR;
				console.error(err.message);
			}
		}
	);
}

function scanFileAreas() {
	const options = {};

	const tags = argv.tags;
	if(tags) {
		options.tags = tags.split(',');
	}

	options.areaAndStorageInfo = getAreaAndStorage(argv._.slice(2));

	async.series(
		[
			function init(callback) {
				return initConfigAndDatabases(callback);
			},
			function scanAreas(callback) {
				fileArea = require('../../core/file_base_area.js');

				async.eachSeries(options.areaAndStorageInfo, (areaAndStorage, nextAreaTag) => {
					const areaInfo = fileArea.getFileAreaByTag(areaAndStorage.areaTag);
					if(!areaInfo) {
						return nextAreaTag(new Error(`Invalid file base area tag: ${areaAndStorage.areaTag}`));
					}

					console.info(`Processing area "${areaInfo.name}":`);

					scanFileAreaForChanges(areaInfo, options, err => {
						return callback(err);
					});
				}, err => {
					return callback(err);
				});
			}
		],
		err => {
			if(err) {
				process.exitCode = ExitCodes.ERROR;
				console.error(err.message);
			}
		}
	);
}

function moveFiles() {
	//
	//	oputil fb move SRC [SRC2 ...] DST
	//
	//	SRC: PATH|FILE_ID|SHA|AREA_TAG[@STORAGE_TAG]
	//	DST: AREA_TAG[@STORAGE_TAG]
	//
	if(argv._.length < 4) {
		return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.ERROR);
	}

	const moveArgs = argv._.slice(2);
	let src = getAreaAndStorage(moveArgs.slice(0, -1));
	let dst = getAreaAndStorage(moveArgs.slice(-1))[0];
	let FileEntry;

	async.waterfall(
		[
			function init(callback) {
				return initConfigAndDatabases( err => {
					if(!err) {
						fileArea = require('../../core/file_base_area.js');
					}
					return callback(err);
				});
			},
			function validateAndExpandSourceAndDest(callback) {
				let srcEntries = [];

				const areaInfo = fileArea.getFileAreaByTag(dst.areaTag);
				if(areaInfo) {
					dst.areaInfo = areaInfo;
				} else {
					return callback(Errors.DoesNotExist('Invalid or unknown destination area'));
				}

				//	Each SRC may be PATH|FILE_ID|SHA|AREA_TAG[@STORAGE_TAG]
				FileEntry = require('../../core/file_entry.js');

				async.eachSeries(src, (areaAndStorage, next) => {
					//
					//	If this entry represents a area tag, it means *all files* in that area
					//
					const areaInfo = fileArea.getFileAreaByTag(areaAndStorage.areaTag);
					if(areaInfo) {
						src.areaInfo = areaInfo;

						const findFilter = {
							areaTag : areaAndStorage.areaTag,
						};

						if(areaAndStorage.storageTag) {
							findFilter.storageTag = areaAndStorage.storageTag;
						}

						FileEntry.findFiles(findFilter, (err, fileIds) => {
							if(err) {
								return next(err);
							}

							async.each(fileIds, (fileId, nextFileId) => {
								const fileEntry = new FileEntry();
								fileEntry.load(fileId, err => {
									if(!err) {
										srcEntries.push(fileEntry);
									}
									return nextFileId(err);
								});
							}, 
							err => {
								return next(err);
							});
						});

					} else {
						//	PATH|FILE_ID|SHA|PARTIAL_SHA
						getSpecificFileEntry(areaAndStorage.pattern, (err, fileEntry) => {
							if(err) {
								return next(err);
							}
							srcEntries.push(fileEntry);
							return next(null);
						});
					}
				},
				err => {
					return callback(err, srcEntries);
				});
			},
			function moveEntries(srcEntries, callback) {
				
				if(!dst.storageTag) {
					dst.storageTag = dst.areaInfo.storageTags[0];
				}
				
				const destDir = FileEntry.getAreaStorageDirectoryByTag(dst.storageTag);
				
				async.eachSeries(srcEntries, (entry, nextEntry) => {			
					const srcPath 	= entry.filePath;
					const dstPath	= paths.join(destDir, entry.fileName);

					process.stdout.write(`Moving ${srcPath} => ${dstPath}... `);

					FileEntry.moveEntry(entry, dst.areaTag, dst.storageTag, err => {
						if(err) {
							console.info(`Failed: ${err.message}`);
						} else {
							console.info('Done');
						}
						return nextEntry(null);	//	always try next
					});					
				},
				err => {
					return callback(err);
				});
			}
		]
	);
}

function handleFileBaseCommand() {
	if(true === argv.help) {
		return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.ERROR);
	}

	const action = argv._[1];

	switch(action) {
		case 'info' : return displayFileAreaInfo();
		case 'scan' : return scanFileAreas();
		case 'move' : return moveFiles();

		default : return printUsageAndSetExitCode(getHelpFor('FileBase'), ExitCodes.ERROR);
	}
}