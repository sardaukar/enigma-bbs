/* jslint node: true */
'use strict';

var ViewController			= require('./view_controller.js').ViewController;
var ansi					= require('./ansi_term.js');
var theme					= require('./theme.js');
var MultiLineEditTextView	= require('./multi_line_edit_text_view.js').MultiLineEditTextView;
var Message					= require('./message.js');

var async					= require('async');
var events					= require('events');
var assert					= require('assert');
var _						= require('lodash');

module.exports				= FullScreenEditor;

function FullScreenEditor(options) {
	events.EventEmitter.call(this);

	assert(_.isObject(options.client));
	assert(_.isObject(options.art));
	assert(_.isString(options.editorType));

	var self = this;

	//
	//	options.callingMenu		: menu that created us
	//	options.client
	//	options.art{}			: name -> artAsset
	//	options.font			: optional
	//	options.editorMode	(view|edit|quote) | (editMenu|)
	//	
	//	options.editorType		: email | area
	this.callingMenu	= options.callingMenu;
	this.client			= options.client;
	this.art			= options.art;
	this.font			= options.font;
	this.editorType		= options.editorType;

	this.mciData		= {};

	this.editorMode		= 'edit';	//	view | edit | editMenu | 

	this.initViewControllers();

	this.getFooterName = function(editorMode) {
		editorMode = editorMode || this.editorMode;
		return 'footer' + _.capitalize(editorMode);	//	e.g.. 'footerEditMenu'
	};

	this.getFormId = function(name) {
		return {
			header			: 0,
			body			: 1,
			footerEdit		: 2,
			footerEditMenu	: 3,
			footerView		: 4,

			help			: 50,
		}[name];
	};

	this.isViewMode = function() {
		return 'view' === this.editorMode;
	};

	this.redrawFooter = function(options, cb) {
		async.waterfall(
			[
				function moveToFooterPosition(callback) {
					//
					//	Calculate footer staring position
					//
					//	row = (header height + body height)
					//
					//	Header: mciData.body.height
					//	Body  : We must find this in the config / theme
					//
					//	:TODO: don't hard code this -- allow footer height to be part of theme/etc.
					self.client.term.rawWrite(ansi.goto(23, 1));
					callback(null);
				},
				function clearFooterArea(callback) {
					if(options.clear) {
						self.client.term.rawWrite(ansi.reset() + ansi.deleteLine(3));
					}
					callback(null);
				},
				function displayFooterArt(callback) {
					var footerArt = self.art[options.footerName];

					theme.displayThemedAsset(
						footerArt,
						self.client,
						{ font : self.font },
						function displayed(err, artData) {
							callback(err, artData);
						}
					);
				}
			],
			function complete(err, artData) {
				cb(err, artData);
			}
		);
	};

	this.redrawAll = function(options, cb) {
		var artComponents	= [ 'header', 'body' ];
		var art				= self.art;

		self.client.term.rawWrite(ansi.resetScreen());

		async.series(
			[
				function displayHeaderAndBody(callback) {
					async.eachSeries( artComponents, function dispArt(n, next) {
						theme.displayThemedAsset(
							art[n],
							self.client,
							{ font : self.font },
							function displayed(err, artData) {
								if(options.initMci) {
									self.mciData[n] = artData;
								}
								next(err);
							}
						);
					}, function complete(err) {
						callback(err);
					});
				},
				function displayFooter(callback) {
					//	we have to treat the footer special
					var footerName = self.getFooterName();
					self.redrawFooter( { clear : false, footerName : footerName }, function footerDisplayed(err, artData) {
						if(options.initMci) {
							self.mciData[footerName] = artData;
						}
						callback(err);
					});
				},
				function refreshViews(callback) {
					if(options.refreshViews) {
						artComponents.push(self.getFooterName());

						artComponents.forEach(function artComp(n) {
							self.viewControllers[n].redrawAll();
						});
					}
					callback(null);					
				}
			],
			function complete(err) {
				cb(err);
			}
		);	
	};

	this.createInitialViews = function(cb) {
		
		var menuLoadOpts = { callingMenu : self.callingMenu	};

		async.series(
			[
				function header(callback) {
					menuLoadOpts.formId = self.getFormId('header');
					menuLoadOpts.mciMap	= self.mciData.header.mciMap;

					self.addViewController(
						'header', 
						new ViewController( { client : self.client, formId : menuLoadOpts.formId } )
					).loadFromMenuConfig(menuLoadOpts, function headerReady(err) {
						callback(err);
					});
				},
				function body(callback) {
					menuLoadOpts.formId	= self.getFormId('body');
					menuLoadOpts.mciMap	= self.mciData.body.mciMap;

					self.addViewController(
						'body',
						new ViewController( { client : self.client, formId : menuLoadOpts.formId } )
					).loadFromMenuConfig(menuLoadOpts, function bodyReady(err) {
						callback(err);
					});
				},
				function footer(callback) {
					var footerName = self.getFooterName();

					menuLoadOpts.formId = self.getFormId(footerName);
					menuLoadOpts.mciMap = self.mciData[footerName].mciMap;

					self.addViewController(
						footerName,
						new ViewController( { client : self.client, formId : menuLoadOpts.formId } )
					).loadFromMenuConfig(menuLoadOpts, function footerReady(err) {
						callback(err);
					});
				},
				function prepare(callback) {
					var header = self.viewControllers.header;
					var from = header.getView(1);
					from.acceptsFocus = false;
					from.setText(self.client.user.username);

					callback(null);
				},
				function setInitialFocus(callback) {
					self.viewControllers.body.setFocus(false);
					self.viewControllers.header.switchFocus(2);
					callback(null);
				}
			],
			function complete(err) {
				cb(err);
			}
		);
	};

	this.switchFooter = function(cb) {
		var footerName = self.getFooterName();
	
		self.redrawFooter( { footerName : footerName, clear : true }, function artDisplayed(err, artData) {
			if(err) {
				cb(err);
				return;
			}

			var formId = self.getFormId(footerName);

			if(_.isUndefined(self.viewControllers[footerName])) {
				console.log(artData)
				var menuLoadOpts = {
					callingMenu	: self.callingMenu,
					formId		: formId,
					mciMap		: artData.mciMap
				};

				self.addViewController(
					footerName,
					new ViewController( { client : self.client, formId : formId } )
				).loadFromMenuConfig(menuLoadOpts, function footerReady(err) {
					cb(err);
				});
			} else {
				self.viewControllers[footerName].redrawAll();
				cb(null);
			}
		});
	};
}

require('util').inherits(FullScreenEditor, events.EventEmitter);
require('./mod_mixins.js').ViewControllerManagement.call(FullScreenEditor.prototype);

FullScreenEditor.prototype.enter = function() {

	var self = this;

	async.series(
		[
			function drawScreen(callback) {
				self.redrawAll( { initMci : true }, function allDrawn(err) {
					callback(err);
				});
			},
			function createViews(callback) {
				self.createInitialViews(function viewsCreated(err) {
					callback(err);
				});
			},
		],
		function complete(err) {
			if(err) {
				self.emit('error', err);
			}
		}
	);
};

FullScreenEditor.prototype.leave = function() {

};

FullScreenEditor.prototype.submitHandler = function(formData, extraArgs) {
	var self = this;

	//	:TODO: Use key map from config for this stuff

	if(formData.id === self.getFormId('header')) {
		//	:TODO: we need to validate the "to" here
		self.viewControllers.header.setFocus(false);
		self.viewControllers.body.switchFocus(1);		
	} else if(formData.id === self.getFormId('body') && formData.key && 'escape' === formData.key.name) {
		if(!self.isViewMode()) {
			self.editorMode = 'edit' === self.editorMode ? 'editMenu' : 'edit';

			self.switchFooter(function next(err) {
				if(err) {
					//	:TODO:... what now?
					console.log(err)
				} else {
					switch(self.editorMode) {
						case 'edit' :
							if(!_.isUndefined(self.viewControllers.footerEditMenu)) {
								self.viewControllers.footerEditMenu.setFocus(false);
							}
							self.viewControllers.body.switchFocus(1);
							self.observeEditEvents();
							break;

						case 'editMenu' :
							self.viewControllers.body.setFocus(false);
							self.viewControllers.footerEditMenu.switchFocus(1);
							break;

						default : throw new Error('Unexpected mode');
					}
					
				}
			});
		}
	}
};