var
	fs = require('fs'),
	exec = require('child_process').exec,
	async = require('async'),
	xtend = require('xtend'),
	moment = require('moment'),
	mkdirp = require('mkdirp'),
	request = require('request');

var
	opts_def = {
		'user':'just-paja',
		'proto':'https',
		'host':'api.github.com',
		'per_page':64,
		'concurrency':32,
		'urls':{
			'repos':'{{proto}}://{{host}}/users/{{user}}/repos?page={{page}}&per_page={{per_page}}'
		}
	};


var get_url = function(str, params)
{
	for (var key in params) {
		str = str.replace('{{' + key + '}}', params[key]);
	}

	return str;
};


var get_repos = function(opts, next)
{
	get_repo_list(opts, null, function(err, list) {
		var
			repos = 0,
			forks = 0;

		for (var i = 0; i < list.length; i++) {
			if (list[i].fork) {
				forks ++;
			} else {
				repos ++;
			}
		}

		console.log(':: Found ' + repos + ' repositories and ' + forks + ' forks');
		next(err, list);
	});
};


var get_repo_page = function(opts, page, next)
{
	var url_opts = {
		'url':get_url(opts.urls.repos, xtend(opts, {'page':page})),
		'headers':{
			'User-Agent':'github-sync'
		}
	};

	request(url_opts, function(err, res, body) {
		if (!err) {
			if (res.statusCode == 200) {
				try {
					body = JSON.parse(body);
				} catch(e) {
					err = e;
				}
			} else {
				if (res.body) {
					try {
						err = JSON.parse(res.body);
					} catch(e) {
						err = res.body;
					}
				} else {
					err = res.headers.status;
				}
			}
		}

		next(err, body);
	});
};


var get_repo_list = function(opts, helper, next)
{
	if (!(helper instanceof Object)) {
		console.log(':: Fetching repository list');

		helper = {
			'list':[],
			'page':1
		};
	}

	get_repo_page(opts, helper.page, function(helper, next) {
		return function(err, list_page) {
			for (var i = 0; i < list_page.length; i++) {
				helper.list.push(list_page[i]);
			}

			if (list_page.length >= opts.per_page) {
				helper.page++;
				get_repo_list(opts, helper, next);
			} else {
				next(err, helper.list);
			}
		};
	}(helper, next));
};


var get_project_paths = function(repo)
{
	var
		lang = repo.language,
		paths = {};

	if (repo.language) {
		lang = lang.toLowerCase();
	} else {
		lang = 'misc';
	}

	paths.base = repo.opts.path + '/' + lang;
	paths.root = paths.base + '/' + repo.name;
	paths.git  = paths.root + '/.git';
	paths.relative = lang + '/' + repo.name;

	return paths;
};


var get_project_cmds = function(repo)
{
	var
		paths = get_project_paths(repo),
		cd    = 'cd ' + paths.root + ';',
		cmds  = {
			'clone':'cd ' + paths.base + ';' + 'git clone -q ssh://git@github.com/' + repo.opts.user + '/' + repo.name + '.git',
			'fetch':cd + 'git fetch',
			'fetch_refs':cd + 'git fetch -q --all',
			'pull':cd + 'git pull -q --all',
			'push':cd + 'git push --porcelain',
			'push_refs':cd + 'git push --porcelain --all',
			'clear_tags':cd + 'git push --porcelain --prune --tags',
			'status':cd + 'git status --porcelain -u',

			'local_head':cd + 'git rev-parse HEAD',
			'remote_head':cd + 'git rev-parse origin/master',
		};

	return cmds;
};


var git_cmd = function(cmd, repo, next)
{
	var
		paths = get_project_paths(repo),
		cmds  = get_project_cmds(repo);

	exec(cmds[cmd], function(err, stdout, stderr) {
		if (err || stderr) {
			next({
				'fail':'git cmd',
				'what':cmd,
				'cmd':cmds[cmd],
				'repo':repo.name,
				'paths':paths,
				'error':err ? err:stderr,
				'stdout':stdout
			});
		} else {
			next(err, stdout, stderr);
		}
	});
};


var repo_clone = function(repo, next)
{
	var
		paths = get_project_paths(repo),
		cmds = get_project_cmds(repo),
		jobs = [];

	jobs.push(function(next) {
		git_cmd('clone', repo, next);
	});

	jobs.push(function(next) {
		git_cmd('fetch_refs', repo, next);
	});

	console.log('  -> Cloning ' + repo.full_name);
	async.series(jobs, next);
};


var repo_update = function(repo, next)
{
	var jobs  = [];

	jobs.push(function(next) {
		git_cmd('fetch_refs', repo, next);
	});

	jobs.push(function(next) {
		git_cmd('pull', repo, next);
	});

	jobs.push(function(next) {
		var jobs = [];

		jobs.push(function(next) {
			git_cmd('local_head', repo, function(err, stdout) {
				next(err, stdout);
			});
		});

		jobs.push(function(local, next) {
			git_cmd('remote_head', repo, function(err, stdout) {
				next(err, {
					'local':local,
					'remote':stdout
				});
			});
		});

		jobs.push(function(head, next) {
			if (head.local == head.remote) {
				next();
			} else {
				git_cmd('push', repo, next);
			}
		});

		async.waterfall(jobs, next);
	});

	jobs.push(function(next) {
		git_cmd('push_refs', repo, next);
	});

	jobs.push(function(next) {
		git_cmd('clear_tags', repo, next);
	});

	if (repo.opts.verbose) {
		console.log('  -> Updating ' + repo.full_name);
	}

	async.series(jobs, function(err) {
		if (repo.opts.verbose) {
			console.log('  -> Finished updating ' + repo.full_name);
		}

		next(err);
	});
};


var repo_sync = function(repo, next)
{
	var
		paths = get_project_paths(repo),
		jobs  = [],
		res   = {
			'name':repo.name,
			'exists':false,
			'git':false
		};

	// Check and create project base dir
	jobs.push(function(next) {
		fs.exists(paths.base, function(exists) {
			if (exists) {
				next();
			} else {
				mkdirp(paths.base, next);
			}
		});
	});

	// Check if project directory exists
	jobs.push(function(next) {
		fs.exists(paths.root, function(exists) {
			res.exists = exists;
			next();
		});
	});

	// Check if git repository exist
	jobs.push(function(next) {
		if (res.exists) {
			fs.exists(paths.git, function(e) {
				res.exists = e;

				next(e ? null:{
					'project':repo.name,
					'error':'Exists, but is not git repository',
					'paths':paths,
					'res':res
				});
			});
		} else {
			next();
		}
	});

	// Update repository
	jobs.push(function(next) {
		if (res.exists) {
			repo_update(repo, next);
		} else {
			repo_clone(repo, next);
		}
	});

	async.series(jobs, function(err) {
		next(err, res);
	});
};


var repo_check = function(repo, next)
{
	var jobs = [];

	jobs.push(function(next) {
		fs.exists(repo.paths.root, function(e) {
			next(null, e);
		});
	});

	jobs.push(function(e, next) {
		if (e) {
			git_cmd('status', repo, next);
		} else {
			next(null, null, null);
		}
	});

	jobs.push(function(stdout, stderr, next) {
		var res = {
			'repo':repo.name,
			'full_name':repo.full_name,
			'paths':repo.paths,
			'modified':[]
		};

		if (typeof stdout == 'string' && stdout) {
			res.modified = stdout.split("\n");
		}

		next(stderr, res);
	});

	async.waterfall(jobs, next);
};


var sync_repositories = function(opts, list, next)
{
	var jobs = [];

	for (var i = 0; i < list.length; i++) {
		var repo = list[i];

		if (opts.forks || !repo.fork) {
			jobs.push(function(repo) {
				return function(next) {
					var repo_jobs = [];

					repo.opts = opts;
					repo.paths = get_project_paths(repo);
					repo.full_name = repo.paths.relative;

					repo_jobs.push(function(next) {
						repo_sync(repo, next);
					});

					repo_jobs.push(function(res, next) {
						jobs.finished ++;

						if (!repo.opts.verbose) {
							process.stdout.write("\r  -> " + jobs.finished + '/' + jobs.length + "    ");
						}

						next(null, res);
					});

					async.waterfall(repo_jobs, next);
				};
			}(repo));
		}
	}

	console.log(':: Syncing ' + jobs.length + ' repositories in ' + opts.concurrency + ' threads');
	jobs.finished = 0;

	async.parallelLimit(jobs, opts.concurrency, function(err) {
		if (!opts.verbose) {
			process.stdout.write("\n");
		}

		next();
	});
};


var check_repositories = function(opts, list, next)
{
	var jobs = [];

	for (var i = 0; i < list.length; i++) {
		var repo = list[i];

		if (opts.forks || !repo.fork) {
			jobs.push(function(repo) {
				return function(next) {
					var repo_jobs = [];

					repo.opts = opts;
					repo.paths = get_project_paths(repo);
					repo.full_name = repo.paths.relative;

					repo_jobs.push(function(next) {
						repo_check(repo, next);
					});

					repo_jobs.push(function(res, next) {
						jobs.finished ++;

						if (!repo.opts.verbose) {
							process.stdout.write("\r  -> " + jobs.finished + '/' + jobs.length + "    ");
						}

						next(null, res);
					});

					async.waterfall(repo_jobs, next);
				};
			}(repo));
		}
	}

	console.log(':: Checking local status');
	jobs.finished = 0;

	async.parallel(jobs, function(err, results) {
		var modified = [];

		if (!opts.verbose) {
			process.stdout.write("\n");
		}

		if (err) {
			next(err);
			return;
		}


		for (var i = 0; i < results.length; i++) {
			var res = results[i];

			if (res.modified.length) {
				modified.push([
					"    Repository " + res.full_name,
					res.modified.map(function(val) {
						return "      " + val;
					}).join("\n")
				].join("\n"));
			}
		}

		if (modified.length) {
			next({
				'message':'Following changes must be commited first',
				'items':modified
			});
		} else {
			next();
		}
	});
};


var sync = function(opts, next)
{
	var
		opts = xtend(opts_def, opts);
		jobs = [];

	jobs.push(function(next) {
		get_repos(opts, next);
	});

	jobs.push(function(list, next) {
		var jobs = [];

		jobs.push(function(next) {
			check_repositories(opts, list, next);
		});

		if (!opts.status) {
			jobs.push(function(next) {
				sync_repositories(opts, list, next);
			});
		}

		async.series(jobs, next);
	});


	console.log(':: Starting sync with GitHub user ' + opts.user);
	async.waterfall(jobs, next);
};


module.exports = sync;
